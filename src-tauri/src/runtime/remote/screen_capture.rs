use std::time::{Duration, Instant};

use axum::body::Bytes;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, watch};
use windows::{
    Win32::{
        Graphics::Gdi::{DISPLAY_DEVICE_ACTIVE, DISPLAY_DEVICEW, EnumDisplayDevicesW},
        System::RemoteDesktop::{
            WTS_CURRENT_SESSION, WTS_SESSIONSTATE_UNLOCK, WTSActive, WTSFreeMemory, WTSINFOEXW,
            WTSQuerySessionInformationW, WTSSessionInfoEx,
        },
        UI::WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME,
    },
    core::{PCWSTR, PWSTR},
};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    encoder::ImageEncoder,
    frame::{Frame, ImageFormat},
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

const FRAME_INTERVAL: Duration = Duration::from_micros(16_667); // 60 FPS max.
// Keep the latest-frame mailbox bounded without imposing a resolution cap.
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
pub(super) struct Display {
    pub id: String,
    pub primary: bool,
}

pub(super) fn displays() -> Result<Vec<(Display, Monitor)>, String> {
    let primary = Monitor::primary().map_err(|error| error.to_string())?;
    let mut displays = Vec::new();
    for monitor in Monitor::enumerate().map_err(|error| error.to_string())? {
        let Some(id) = monitor_id(monitor) else {
            continue;
        };
        let primary = monitor.as_raw_hmonitor() == primary.as_raw_hmonitor();
        displays.push((Display { id, primary }, monitor));
    }
    displays.sort_by_key(|(display, _)| !display.primary);
    Ok(displays)
}

pub(super) fn monitor_id(monitor: Monitor) -> Option<String> {
    let name: Vec<_> = monitor
        .device_name()
        .ok()?
        .encode_utf16()
        .chain([0])
        .collect();
    let mut paths = Vec::new();
    for index in 0.. {
        let mut device = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        // SAFETY: the source name is NUL-terminated and device is a writable DISPLAY_DEVICEW.
        if !unsafe {
            EnumDisplayDevicesW(
                PCWSTR(name.as_ptr()),
                index,
                &mut device,
                EDD_GET_DEVICE_INTERFACE_NAME,
            )
        }
        .as_bool()
        {
            break;
        }
        if (device.StateFlags & DISPLAY_DEVICE_ACTIVE) != DISPLAY_DEVICE_ACTIVE {
            continue;
        }
        let end = device.DeviceID.iter().position(|&unit| unit == 0)?;
        if end == 0 {
            return None;
        }
        paths.push(String::from_utf16(&device.DeviceID[..end]).ok()?);
    }
    if paths.is_empty() {
        return None;
    }
    // A GDI source name can be reassigned. Hash the active monitor interfaces,
    // including all targets of a mirrored source, without exposing them to the browser.
    paths.sort_unstable();
    Some(format!("{:x}", Sha256::digest(paths.join("\0"))))
}

pub(super) fn desktop_unlocked() -> bool {
    let mut buffer = PWSTR::null();
    let mut length = 0;
    // SAFETY: WTS supplies the buffer and its size; this thread owns it until WTSFreeMemory.
    unsafe {
        if WTSQuerySessionInformationW(
            None,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut length,
        )
        .is_err()
            || buffer.is_null()
        {
            return false;
        }
        let unlocked = if (length as usize) >= std::mem::size_of::<WTSINFOEXW>() {
            let info = buffer.0.cast::<WTSINFOEXW>().read_unaligned();
            info.Level == 1 && {
                let session = info.Data.WTSInfoExLevel1;
                session.SessionState == WTSActive
                    && session.SessionFlags == WTS_SESSIONSTATE_UNLOCK as i32
            }
        } else {
            false
        };
        WTSFreeMemory(buffer.0.cast());
        unlocked
    }
}

pub(super) struct Capture(Option<(CaptureControl<JpegCapture, String>, OwnedSemaphorePermit)>);

impl Capture {
    pub(super) fn start(
        monitor: Monitor,
        permit: OwnedSemaphorePermit,
    ) -> Result<(Self, watch::Receiver<Option<Bytes>>), String> {
        let (sender, receiver) = watch::channel(None);
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            sender,
        );
        let control =
            JpegCapture::start_free_threaded(settings).map_err(|error| error.to_string())?;
        Ok((Self(Some((control, permit))), receiver))
    }

    pub(super) fn is_finished(&self) -> bool {
        self.0
            .as_ref()
            .is_none_or(|(control, _)| control.is_finished())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Some((control, permit)) = self.0.take() {
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                if let Err(error) = control.stop() {
                    log::debug!(target: "remote-webui", "screen capture stopped: {error}");
                }
            });
        }
    }
}

struct JpegCapture {
    frames: watch::Sender<Option<Bytes>>,
    encoder: ImageEncoder,
    packed: Vec<u8>,
    last_frame: Option<Instant>,
}

impl GraphicsCaptureApiHandler for JpegCapture {
    type Flags = watch::Sender<Option<Bytes>>;
    type Error = String;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            frames: context.flags,
            encoder: ImageEncoder::new(ImageFormat::Jpeg, ColorFormat::Bgra8),
            packed: Vec::new(),
            last_frame: None,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // WGC may only deliver on damage. Delay rather than discard the last update.
        if let Some(delay) = self
            .last_frame
            .and_then(|time| FRAME_INTERVAL.checked_sub(time.elapsed()))
        {
            std::thread::sleep(delay);
        }
        if self.frames.is_closed() {
            capture_control.stop();
            return Ok(());
        }
        self.last_frame = Some(Instant::now());
        let width = frame.width();
        let height = frame.height();
        if width == 0 || height == 0 {
            return Ok(());
        }
        let mut pixels = frame.buffer().map_err(|error| error.to_string())?;
        let pitch = pixels.row_pitch() as usize;
        let row_bytes = width as usize * 4;
        let src = pixels.as_raw_buffer();
        let data = if pitch == row_bytes {
            &src[..row_bytes * height as usize]
        } else {
            self.packed.resize(row_bytes * height as usize, 0);
            for (row, src_row) in self
                .packed
                .chunks_exact_mut(row_bytes)
                .zip(src.chunks_exact(pitch))
            {
                row.copy_from_slice(&src_row[..row_bytes]);
            }
            &self.packed
        };
        let jpeg = self
            .encoder
            .encode(data, width, height)
            .map_err(|error| error.to_string())?;
        if jpeg.len() <= MAX_FRAME_BYTES {
            self.frames.send_replace(Some(Bytes::from(jpeg)));
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.frames.send_replace(None);
        Ok(())
    }
}
