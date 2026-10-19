use rusqlite::{Connection as SqliteConnection, OptionalExtension, params};

use crate::domain::{PromptEnhancementModel, PromptEnhancementSettings};

pub(crate) fn get_prompt_enhancement_settings(
    db: &SqliteConnection,
    connection_id: &str,
) -> Result<PromptEnhancementSettings, String> {
    if super::get_connection(db, connection_id)?.is_none() {
        return Err(format!("Connection '{connection_id}' was not found"));
    }
    let stored = db.query_row(
        "SELECT enabled,provider,model_id,updated_at_ms FROM connection_prompt_enhancement_settings WHERE connection_id=?1",
        params![connection_id],
        |row| Ok((row.get::<_, bool>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?)),
    ).optional().map_err(|error| error.to_string())?;
    let (enabled, provider, model_id, revision) = stored.unwrap_or((false, None, None, 0));
    let model = match (provider, model_id) {
        (Some(provider), Some(id)) => Some(PromptEnhancementModel { provider, id }),
        (None, None) => None,
        _ => return Err("invalid stored enhancement model".to_owned()),
    };
    Ok(PromptEnhancementSettings {
        connection_id: connection_id.to_owned(),
        enabled,
        model,
        updated_at_ms: revision as u64,
    })
}

pub(crate) fn set_prompt_enhancement_settings(
    db: &SqliteConnection,
    connection_id: &str,
    enabled: bool,
    model: Option<PromptEnhancementModel>,
) -> Result<PromptEnhancementSettings, String> {
    if super::get_connection(db, connection_id)?.is_none() {
        return Err(format!("Connection '{connection_id}' was not found"));
    }
    if let Some(model) = &model
        && (model.provider.trim().is_empty()
            || model.id.trim().is_empty()
            || model.provider.len() > 256
            || model.id.len() > 512)
    {
        return Err(
            "enhancement model provider and id must be nonempty and within limits".to_owned(),
        );
    }
    let revision = db.query_row(
        "INSERT INTO connection_prompt_enhancement_settings(connection_id,enabled,provider,model_id,updated_at_ms) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(connection_id) DO UPDATE SET enabled=excluded.enabled,provider=excluded.provider,model_id=excluded.model_id,updated_at_ms=MAX(excluded.updated_at_ms,connection_prompt_enhancement_settings.updated_at_ms+1)
         RETURNING updated_at_ms",
        params![connection_id, enabled, model.as_ref().map(|model| &model.provider), model.as_ref().map(|model| &model.id), super::now_ms() as i64],
        |row| row.get::<_, i64>(0),
    ).map_err(|error| format!("failed to save prompt enhancement settings: {error}"))?;
    Ok(PromptEnhancementSettings {
        connection_id: connection_id.to_owned(),
        enabled,
        model,
        updated_at_ms: revision as u64,
    })
}
