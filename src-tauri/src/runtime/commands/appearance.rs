/// 枚举系统已安装的字体族名，供外观设置的全量字体候选使用。
/// 运行目标是 Windows：用 DirectWrite 枚举；其他平台仅用于开发构建检查，
/// 返回空列表，前端回退到内置候选。
#[tauri::command]
pub async fn system_font_families() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        enumerate_system_font_families()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[cfg(target_os = "windows")]
fn enumerate_system_font_families() -> Result<Vec<String>, String> {
    use std::collections::BTreeSet;

    use windows::Win32::Graphics::DirectWrite::{
        DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection,
    };
    use windows::core::BOOL;
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

        let mut families = BTreeSet::new();
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
            if !name.trim().is_empty() {
                families.insert(name);
            }
        }
        Ok(families.into_iter().collect())
    }
}
