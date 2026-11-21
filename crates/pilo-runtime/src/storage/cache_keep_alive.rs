use rusqlite::{Connection as SqliteConnection, params};

use pilo_domain::CacheKeepAliveSettings;

pub(crate) fn list_cache_keep_alive_settings(
    db: &SqliteConnection,
    connection_id: &str,
) -> Result<Vec<CacheKeepAliveSettings>, String> {
    if super::get_connection(db, connection_id)?.is_none() {
        return Err(format!("Connection '{connection_id}' was not found"));
    }
    let mut statement = db.prepare(
        "SELECT provider,model_id,enabled,cache_ttl_seconds,idle_keep_alive_seconds,updated_at_ms
         FROM model_cache_keep_alive_settings WHERE connection_id=?1 ORDER BY provider,model_id",
    ).map_err(|error| error.to_string())?;
    statement
        .query_map(params![connection_id], |row| {
            Ok(CacheKeepAliveSettings {
                connection_id: connection_id.to_owned(),
                provider: row.get(0)?,
                model_id: row.get(1)?,
                enabled: row.get(2)?,
                cache_ttl_seconds: row.get(3)?,
                idle_keep_alive_seconds: row.get(4)?,
                updated_at_ms: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn set_cache_keep_alive_settings(
    db: &SqliteConnection,
    mut settings: CacheKeepAliveSettings,
) -> Result<CacheKeepAliveSettings, String> {
    if super::get_connection(db, &settings.connection_id)?.is_none() {
        return Err(format!(
            "Connection '{}' was not found",
            settings.connection_id
        ));
    }
    if settings.provider.trim().is_empty()
        || settings.provider.len() > 256
        || settings.model_id.trim().is_empty()
        || settings.model_id.len() > 512
        || !(10..=86_400).contains(&settings.cache_ttl_seconds)
        || !(60..=86_400).contains(&settings.idle_keep_alive_seconds)
    {
        return Err("invalid cache keep-alive settings: TTL must be 10–86400 seconds and idle duration 60–86400 seconds".to_owned());
    }
    settings.updated_at_ms = db.query_row(
        "INSERT INTO model_cache_keep_alive_settings(connection_id,provider,model_id,enabled,cache_ttl_seconds,idle_keep_alive_seconds,updated_at_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(connection_id,provider,model_id) DO UPDATE SET
           enabled=excluded.enabled,cache_ttl_seconds=excluded.cache_ttl_seconds,
           idle_keep_alive_seconds=excluded.idle_keep_alive_seconds,
           updated_at_ms=MAX(excluded.updated_at_ms,model_cache_keep_alive_settings.updated_at_ms+1)
         RETURNING updated_at_ms",
        params![settings.connection_id, settings.provider, settings.model_id, settings.enabled,
            settings.cache_ttl_seconds, settings.idle_keep_alive_seconds, super::now_ms()],
        |row| row.get(0),
    ).map_err(|error| format!("failed to save cache keep-alive settings: {error}"))?;
    Ok(settings)
}
