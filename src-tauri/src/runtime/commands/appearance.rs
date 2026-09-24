use serde::Serialize;

/// 单个系统字体族及其等宽判定。
///
/// 等宽判定用平台原生能力（DirectWrite `IsMonospacedFont` / CoreText
/// `kCTFontMonoSpaceTrait`），比前端 canvas 逐字测量的启发式更准，而且整个
/// 枚举+判定跑在 Tauri 的 worker 线程，不阻塞 webview 主线程。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    pub family: String,
    pub monospace: bool,
}

/// 枚举系统已安装的字体族，供外观设置的全量字体候选使用。
/// Windows 用 DirectWrite，macOS 用 CoreText；其他平台仅用于开发构建检查，
/// 返回空列表，前端回退到内置候选。
#[tauri::command]
pub async fn system_font_families() -> Result<Vec<SystemFontFamily>, String> {
    #[cfg(target_os = "windows")]
    {
        enumerate_system_font_families()
    }
    #[cfg(target_os = "macos")]
    {
        enumerate_system_font_families()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
fn enumerate_system_font_families() -> Result<Vec<SystemFontFamily>, String> {
    use core_text::font::new_from_name;
    use core_text::font_descriptor::SymbolicTraitAccessors;

    let families = core_text::font_manager::copy_available_font_family_names();
    Ok(families
        .iter()
        .map(|family| family.to_string())
        .filter(|family| !family.trim().is_empty())
        .map(|family| {
            let monospace = new_from_name(&family, 0.0)
                .map(|font| font.symbolic_traits().is_monospace())
                .unwrap_or(false);
            SystemFontFamily { family, monospace }
        })
        .collect())
}

#[cfg(target_os = "windows")]
fn enumerate_system_font_families() -> Result<Vec<SystemFontFamily>, String> {
    use std::collections::BTreeMap;

    use windows::Win32::Graphics::DirectWrite::{
        DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory, IDWriteFont1,
        IDWriteFontCollection,
    };
    use windows::core::BOOL;
    use windows::core::Interface;
    use windows::core::w;

    unsafe {
        let factory: IDWriteFactory =
            DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).map_err(|error| error.to_string())?;
        let mut collection: Option<IDWriteFontCollection> = None;
        factory
            .GetSystemFontCollection(&mut collection, false)
            .map_err(|error| error.to_string())?;
        let collection =
            collection.ok_or_else(|| "DirectWrite returned no font collection".to_owned())?;

        // BTreeMap 同时按族名排序并去重。
        let mut families = BTreeMap::new();
        for index in 0..collection.GetFontFamilyCount() {
            let Ok(family) = collection.GetFontFamily(index) else {
                continue;
            };
            let Ok(names) = family.GetFamilyNames() else {
                continue;
            };

            // 优先取 en-us 族名，保证不同系统语言下保存的偏好一致；
            // 缺失时退回第一个可用语言（index 0）。
            let mut name_index = 0;
            let mut exists = BOOL::default();
            let _ = names.FindLocaleName(w!("en-us"), &mut name_index, &mut exists);
            if !exists.as_bool() {
                name_index = 0;
            }

            let Ok(length) = names.GetStringLength(name_index) else {
                continue;
            };
            let mut buffer = vec![0u16; length as usize + 1];
            if names.GetString(name_index, &mut buffer).is_err() {
                continue;
            }
            let name = String::from_utf16_lossy(&buffer[..length as usize]);
            if name.trim().is_empty() {
                continue;
            }

            // 取家族首个字体问等宽；IDWriteFont1 不可用（Win7）时按非等宽处理。
            let monospace = family
                .GetFont(0)
                .and_then(|font| font.cast::<IDWriteFont1>())
                .map(|font| font.IsMonospacedFont().as_bool())
                .unwrap_or(false);
            families.insert(name, monospace);
        }

        Ok(families
            .into_iter()
            .map(|(family, monospace)| SystemFontFamily { family, monospace })
            .collect())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::enumerate_system_font_families;

    /// 回归 macOS 上枚举返回空列表的 bug：CoreText 至少应返回一个族名。
    #[test]
    fn enumerates_system_font_families() {
        let families = enumerate_system_font_families().expect("CoreText enumeration failed");
        assert!(
            !families.is_empty(),
            "expected at least one system font family"
        );
        assert!(
            families
                .iter()
                .all(|family| !family.family.trim().is_empty())
        );
        assert!(
            families.iter().any(|family| family.monospace),
            "expected at least one monospace family"
        );
    }
}
