use std::{ffi::c_void, io, ptr, rc::Rc, sync::Arc};

use nsh_core::{
    JsonValue, NodeId, StylePatch,
    element::{CallbackHandle, ClassInstance, JsClass, JsHost, JsKind, JsRaw, PropError, System},
    runtime::{PackageVersion, UpdaterHost, UpdaterSink},
};
use url::{Position, Url};
use windows_sys::{Win32::Networking::WinHttp::*, core::w};

pub(super) struct UpdateCall<'a>(pub &'a dyn JsHost);

macro_rules! forward_js_host {
    ($(fn $name:ident($($arg:ident: $ty:ty),*) $(-> $result:ty)?;)*) => {
        $(fn $name(&self, $($arg: $ty),*) $(-> $result)? {
            self.0.$name($($arg),*)
        })*
    };
}

impl JsHost for UpdateCall<'_> {
    fn system(&self) -> System {
        let mut system = self.0.system();
        system.updater = system
            .updater
            .map(|host| Arc::new(SystemProxyUpdater(host)) as Arc<dyn UpdaterHost>);
        system
    }

    forward_js_host! {
        fn arg(i: usize) -> JsRaw;
        fn this() -> JsRaw;
        fn kind(v: JsRaw) -> JsKind;
        fn class(v: JsRaw) -> Option<JsClass>;
        fn bool(v: JsRaw) -> Option<bool>;
        fn number(v: JsRaw) -> Option<f64>;
        fn string(v: JsRaw) -> Option<String>;
        fn bytes(v: JsRaw) -> Option<Vec<u8>>;
        fn len(v: JsRaw) -> Result<Option<usize>, PropError>;
        fn index(v: JsRaw, i: usize) -> Result<JsRaw, PropError>;
        fn field(v: JsRaw, key: &str) -> Result<JsRaw, PropError>;
        fn keys(v: JsRaw) -> Result<Vec<String>, PropError>;
        fn date(v: JsRaw) -> Option<f64>;
        fn to_json(v: JsRaw) -> Result<JsonValue, PropError>;
        fn describe(v: JsRaw) -> String;
        fn style(v: JsRaw) -> Result<StylePatch, PropError>;
        fn node(v: JsRaw) -> Option<NodeId>;
        fn node_value(id: NodeId) -> JsRaw;
        fn instance(v: JsRaw) -> Option<Rc<dyn ClassInstance>>;
        fn callback(v: JsRaw) -> Option<Rc<dyn CallbackHandle>>;
        fn free(v: JsRaw);
        fn undefined() -> JsRaw;
        fn null() -> JsRaw;
        fn new_bool(b: bool) -> JsRaw;
        fn new_number(n: f64) -> JsRaw;
        fn new_string(s: &str) -> Result<JsRaw, PropError>;
        fn new_bytes(bytes: &[u8]) -> Result<JsRaw, PropError>;
        fn new_date(millis: f64) -> Result<JsRaw, PropError>;
        fn new_array(items: Vec<JsRaw>) -> Result<JsRaw, PropError>;
        fn new_object() -> Result<JsRaw, PropError>;
        fn set_field(obj: JsRaw, key: &str, value: JsRaw) -> Result<(), PropError>;
        fn json(v: &JsonValue) -> Result<JsRaw, PropError>;
        fn wrap(instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError>;
        fn construct(instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError>;
    }
}

struct SystemProxyUpdater(Arc<dyn UpdaterHost>);

impl UpdaterHost for SystemProxyUpdater {
    fn config(&self) -> Option<Vec<u8>> {
        self.0.config()
    }

    fn running_package(&self) -> Option<PackageVersion> {
        self.0.running_package()
    }

    fn get(&self, url: &str, from: u64, sink: UpdaterSink<'_>) -> Result<(), String> {
        get(url, from, sink)
    }
}

fn get(url: &str, from: u64, sink: UpdaterSink<'_>) -> Result<(), String> {
    let url = Url::parse(url).map_err(|_| String::from("invalid update URL"))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("the update URL must use HTTPS without credentials".into());
    }
    let host = url.host_str().ok_or("the update URL has no host")?;
    let host = wide(host);
    let path = wide(&url[Position::BeforePath..Position::AfterQuery]);
    let port = url.port().unwrap_or(443);

    // SAFETY: The strings are NUL-terminated UTF-16. Each live handle stays
    // open until its children close. Output pointers refer to sized buffers.
    unsafe {
        // Open a new session for each fetch so proxy changes take effect on
        // the next request. WinHTTP also resolves the proxy on redirects and
        // disallows HTTPS-to-HTTP redirects by default.
        let session = Handle::new(
            WinHttpOpen(
                w!("Pilo"),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                ptr::null(),
                ptr::null(),
                0,
            ),
            "open session",
        )?;
        check(
            WinHttpSetTimeouts(session.0, 30_000, 30_000, 30_000, 60_000),
            "set timeouts",
        )?;
        let connection = Handle::new(WinHttpConnect(session.0, host.as_ptr(), port, 0), "connect")?;
        let request = Handle::new(
            WinHttpOpenRequest(
                connection.0,
                w!("GET"),
                path.as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                WINHTTP_FLAG_SECURE,
            ),
            "open request",
        )?;
        // WinHTTP forwards these headers across redirects, including GitHub's CDN.
        let mut headers = String::from("Accept-Encoding: identity");
        if from > 0 {
            headers.push_str(&format!("\r\nRange: bytes={from}-"));
        }
        let headers = wide(&headers);
        check(
            WinHttpAddRequestHeaders(
                request.0,
                headers.as_ptr(),
                u32::MAX,
                WINHTTP_ADDREQ_FLAG_ADD,
            ),
            "set download headers",
        )?;
        check(
            WinHttpSendRequest(request.0, ptr::null(), 0, ptr::null(), 0, 0, 0),
            "send request",
        )?;
        check(
            WinHttpReceiveResponse(request.0, ptr::null_mut()),
            "receive response",
        )?;

        let mut status = 0_u32;
        let mut status_bytes = size_of_val(&status) as u32;
        check(
            WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                ptr::null(),
                ptr::from_mut(&mut status).cast(),
                &mut status_bytes,
                ptr::null_mut(),
            ),
            "read HTTP status",
        )?;
        let length = request
            .header(WINHTTP_QUERY_CONTENT_LENGTH)
            .and_then(|value| parse_bytes(value.trim()));
        let (mut offset, total, expected) = match status {
            // A full response replaces the partial file instead of appending to it.
            200 => (0, length, length),
            206 if from > 0 => {
                let range = request.header(WINHTTP_QUERY_CONTENT_RANGE);
                let Some((size, total)) = range
                    .as_deref()
                    .and_then(|value| resume_range(value, from, length))
                else {
                    // Like 416 below, no chunks tells nsh to retry from zero.
                    return Ok(());
                };
                (from, total, Some(size))
            }
            416 if from > 0 => return Ok(()),
            _ => return Err(format!("HTTP {status}")),
        };
        let start = offset;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let mut read = 0;
            check(
                WinHttpReadData(
                    request.0,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut read,
                ),
                "read response body",
            )?;
            let received = offset - start;
            if read == 0 {
                return match expected {
                    Some(size) if size != received => {
                        Err(format!("truncated response ({received} of {size} bytes)"))
                    }
                    _ => Ok(()),
                };
            }
            let next = offset
                .checked_add(u64::from(read))
                .ok_or("download offset overflow")?;
            if expected.is_some_and(|size| next - start > size) {
                if status == 206 && received == 0 {
                    // No chunks reached nsh, so it can retry from zero.
                    return Ok(());
                }
                return Err("response exceeds its declared length".into());
            }
            sink(offset, &buffer[..read as usize], total)?;
            offset = next;
        }
    }
}

/// Validate the returned byte range before allowing any data to be appended.
fn resume_range(value: &str, from: u64, length: Option<u64>) -> Option<(u64, Option<u64>)> {
    let (unit, rest) = value.trim().split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, total) = rest.trim_start().split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = parse_bytes(start)?;
    let end = parse_bytes(end)?.checked_add(1)?;
    let size = end.checked_sub(start)?;
    if start != from || size == 0 || length.is_some_and(|length| length != size) {
        return None;
    }
    let total = if total == "*" {
        None
    } else {
        let total = parse_bytes(total)?;
        if end > total {
            return None;
        }
        Some(total)
    };
    Some((size, total))
}

fn parse_bytes(value: &str) -> Option<u64> {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

struct Handle(*mut c_void);

impl Handle {
    fn new(handle: *mut c_void, operation: &str) -> Result<Self, String> {
        if handle.is_null() {
            Err(network_error(operation))
        } else {
            Ok(Self(handle))
        }
    }

    fn header(&self, name: u32) -> Option<String> {
        // Enough for three u64 values and the Content-Range syntax.
        let mut value = [0_u16; 96];
        let mut bytes = size_of_val(&value) as u32;
        // SAFETY: The handle is live and `bytes` is the buffer capacity in bytes.
        let result = unsafe {
            WinHttpQueryHeaders(
                self.0,
                name,
                ptr::null(),
                value.as_mut_ptr().cast(),
                &mut bytes,
                ptr::null_mut(),
            )
        };
        if result == 0 {
            return None;
        }
        String::from_utf16(value.get(..bytes as usize / 2)?).ok()
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: This object owns the valid WinHTTP handle.
        unsafe { WinHttpCloseHandle(self.0) };
    }
}

fn check(result: i32, operation: &str) -> Result<(), String> {
    if result == 0 {
        Err(network_error(operation))
    } else {
        Ok(())
    }
}

fn network_error(operation: &str) -> String {
    format!(
        "WinHTTP network error ({operation}): {}",
        io::Error::last_os_error()
    )
}
