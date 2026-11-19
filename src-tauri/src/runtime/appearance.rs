use tauri::AppHandle;

use crate::domain::{ThemeSettings, ThemeSettingsUpdate};

use super::{
    RuntimeEventBus,
    events::{RuntimeEvent, RuntimeEventEnvelope},
    storage,
};

pub(crate) async fn load(
    app: AppHandle,
    events: RuntimeEventBus,
    initial: Option<ThemeSettings>,
) -> Result<ThemeSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = storage::open(&crate::desktop_paths::from_app(&app)?)?;
        if let Some(initial) = initial {
            let current = storage::get_theme_settings(&db)?;
            if current.revision > 0 {
                return Ok(current);
            }
            let settings = storage::initialize_theme_settings(&db, initial)?;
            events.send(RuntimeEventEnvelope::global(
                RuntimeEvent::ThemeSettingsChanged {
                    settings: settings.clone(),
                },
            ));
            Ok(settings)
        } else {
            storage::get_theme_settings(&db)
        }
    })
    .await
    .map_err(|error| format!("failed to load theme settings: {error}"))?
}

pub(crate) async fn save(
    app: AppHandle,
    events: RuntimeEventBus,
    update: ThemeSettingsUpdate,
) -> Result<ThemeSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = storage::update_theme_settings(
            &mut storage::open(&crate::desktop_paths::from_app(&app)?)?,
            update,
        )?;
        events.send(RuntimeEventEnvelope::global(
            RuntimeEvent::ThemeSettingsChanged {
                settings: settings.clone(),
            },
        ));
        Ok(settings)
    })
    .await
    .map_err(|error| format!("failed to save theme settings: {error}"))?
}
