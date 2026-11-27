use rusqlite::{Connection as SqliteConnection, OptionalExtension, TransactionBehavior, params};

use pilo_domain::{
    RemoteAccessConfig, RemoteDevice, RemoteHostConfig, RemoteScopes, random_remote_port,
};

fn as_i64(value: u64, field: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("{field} is out of SQLite integer range"))
}

pub(crate) fn get_remote_host_config(db: &SqliteConnection) -> Result<RemoteHostConfig, String> {
    let read = |db: &SqliteConnection| {
        db.query_row(
            "SELECT enabled, port, public_base_url FROM remote_host_config WHERE id=1",
            [],
            |row| {
                Ok(RemoteHostConfig {
                    enabled: row.get::<_, i64>(0)? != 0,
                    port: row.get::<_, u16>(1)?,
                    public_base_url: row.get::<_, String>(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("failed to read Remote WebUI configuration: {error}"))
    };
    if let Some(config) = read(db)? {
        return Ok(config);
    }
    // 首次读取时插入随机五位数端口(INSERT OR IGNORE 幂等);
    // 已有配置不受影响,后续修改经 set_remote_host_config 持久化。
    db.execute(
        "INSERT OR IGNORE INTO remote_host_config(id,enabled,port) VALUES(1,0,?1)",
        params![i64::from(random_remote_port())],
    )
    .map_err(|error| format!("failed to initialize Remote WebUI configuration: {error}"))?;
    read(db)?.ok_or_else(|| "failed to read Remote WebUI configuration: row missing".to_owned())
}

pub(crate) fn get_or_create_host_id(db: &SqliteConnection) -> Result<String, String> {
    let _ = get_remote_host_config(db)?;
    let read_id = |db: &SqliteConnection| {
        db.query_row(
            "SELECT host_id FROM remote_host_config WHERE id=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("failed to read host identity: {error}"))
    };
    let existing = read_id(db)?;
    if !existing.is_empty() {
        return Ok(existing);
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("failed to generate host identity: {error}"))?;
    let mut generated = String::with_capacity(5 + bytes.len() * 2);
    generated.push_str("host-");
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut generated, "{byte:02x}");
    }
    db.execute(
        "UPDATE remote_host_config SET host_id=?1 WHERE id=1 AND host_id=''",
        params![generated],
    )
    .map_err(|error| format!("failed to persist host identity: {error}"))?;
    read_id(db)
}

pub(crate) fn set_remote_host_config(
    db: &SqliteConnection,
    config: &RemoteHostConfig,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO remote_host_config(id,enabled,port,public_base_url)
         VALUES(1,?1,?2,?3)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, port=excluded.port, public_base_url=excluded.public_base_url",
        params![
            i64::from(config.enabled),
            config.port,
            config.public_base_url
        ],
    )
    .map_err(|error| format!("failed to persist Remote WebUI configuration: {error}"))?;
    Ok(())
}

pub(crate) fn get_remote_access_config(
    db: &SqliteConnection,
) -> Result<Option<RemoteAccessConfig>, String> {
    let row = db
        .query_row(
            "SELECT addresses_json,entry_address_id FROM remote_host_config WHERE id=1",
            [],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("failed to read Remote WebUI addresses: {error}"))?;
    let Some((Some(json), entry_address_id)) = row else {
        return Ok(None);
    };
    let addresses = serde_json::from_str(&json)
        .map_err(|error| format!("failed to decode Remote WebUI addresses: {error}"))?;
    Ok(Some(RemoteAccessConfig {
        addresses,
        entry_address_id,
    }))
}

pub(crate) fn set_remote_access_config(
    db: &SqliteConnection,
    config: &RemoteAccessConfig,
) -> Result<(), String> {
    let json = serde_json::to_string(&config.addresses)
        .map_err(|error| format!("failed to encode Remote WebUI addresses: {error}"))?;
    let public_base_url = config
        .addresses
        .iter()
        .find(|address| address.id == "public")
        .map_or("", |address| address.base_url.as_str());
    db.execute(
        "UPDATE remote_host_config SET addresses_json=?1,entry_address_id=?2,public_base_url=?3 WHERE id=1",
        params![json, config.entry_address_id, public_base_url],
    )
    .map_err(|error| format!("failed to save Remote WebUI addresses: {error}"))?;
    Ok(())
}

pub(crate) fn replace_remote_pairing(
    db: &SqliteConnection,
    secret_hash: &str,
    expires_at_ms: u64,
    scopes: RemoteScopes,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO remote_pairing(id,secret_hash,expires_at_ms,consumed_at_ms,scopes)
         VALUES(1,?1,?2,NULL,?3)
         ON CONFLICT(id) DO UPDATE SET
           secret_hash=excluded.secret_hash,
           expires_at_ms=excluded.expires_at_ms,
           consumed_at_ms=NULL,
           scopes=excluded.scopes",
        params![
            secret_hash,
            as_i64(expires_at_ms, "pairing expiry")?,
            scopes.as_str()
        ],
    )
    .map_err(|error| format!("failed to persist Remote WebUI pairing secret: {error}"))?;
    Ok(())
}

pub(crate) fn clear_remote_pairing(db: &SqliteConnection) -> Result<(), String> {
    db.execute("DELETE FROM remote_pairing WHERE id=1", [])
        .map_err(|error| format!("failed to clear Remote WebUI pairing secret: {error}"))?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn consume_remote_pairing(
    db: &mut SqliteConnection,
    secret_hash: &str,
    now_ms: u64,
) -> Result<bool, String> {
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to lock Remote WebUI pairing state: {error}"))?;
    let row = transaction
        .query_row(
            "SELECT secret_hash,expires_at_ms,consumed_at_ms FROM remote_pairing WHERE id=1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to read Remote WebUI pairing state: {error}"))?;
    let valid = row.is_some_and(|(stored_hash, expires_at_ms, consumed_at_ms)| {
        stored_hash == secret_hash
            && consumed_at_ms.is_none()
            && expires_at_ms >= i64::try_from(now_ms).unwrap_or(i64::MAX)
    });
    if valid {
        transaction
            .execute(
                "UPDATE remote_pairing SET consumed_at_ms=?1 WHERE id=1",
                params![as_i64(now_ms, "pairing consume time")?],
            )
            .map_err(|error| format!("failed to consume Remote WebUI pairing secret: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit Remote WebUI pairing state: {error}"))?;
    Ok(valid)
}

pub(crate) fn insert_remote_device(
    db: &SqliteConnection,
    device: &RemoteDevice,
    token_hash: &str,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO remote_devices(
           id,name,pair_ip,token_hash,created_at_ms,last_seen_at_ms,expires_at_ms,revoked_at_ms,scopes
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,?8)",
        params![
            device.id,
            device.name,
            device.pair_ip,
            token_hash,
            as_i64(device.created_at_ms, "device created time")?,
            as_i64(device.last_seen_at_ms, "device last-seen time")?,
            as_i64(device.expires_at_ms, "device expiry")?,
            device.scopes.as_str(),
        ],
    )
    .map_err(|error| format!("failed to persist Remote WebUI device: {error}"))?;
    Ok(())
}

pub(crate) fn insert_remote_pairing_device(
    db: &mut SqliteConnection,
    secret_hash: &str,
    device: &RemoteDevice,
    token_hash: &str,
    exhausted: bool,
) -> Result<bool, String> {
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to lock Remote WebUI pairing state: {error}"))?;
    // A transaction may wait for the database lock; validate TTL after acquiring it.
    let now_ms = super::now_ms();
    let valid = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM remote_pairing WHERE id=1 AND secret_hash=?1
             AND expires_at_ms>?2 AND consumed_at_ms IS NULL AND scopes=?3)",
            params![
                secret_hash,
                as_i64(now_ms, "pairing time")?,
                device.scopes.as_str()
            ],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to validate Remote WebUI pairing: {error}"))?;
    if !valid {
        return Ok(false);
    }
    insert_remote_device(&transaction, device, token_hash)?;
    if exhausted {
        transaction
            .execute(
                "UPDATE remote_pairing SET consumed_at_ms=?1 WHERE id=1",
                params![as_i64(now_ms, "pairing consume time")?],
            )
            .map_err(|error| format!("failed to complete Remote WebUI pairing: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit Remote WebUI pairing: {error}"))?;
    Ok(true)
}

pub(crate) fn rename_remote_device(
    db: &SqliteConnection,
    device_id: &str,
    name: &str,
) -> Result<bool, String> {
    let changed = db
        .execute(
            "UPDATE remote_devices SET name=?1 WHERE id=?2 AND revoked_at_ms IS NULL",
            params![name, device_id],
        )
        .map_err(|error| format!("failed to rename Remote WebUI device: {error}"))?;
    Ok(changed > 0)
}

fn row_to_remote_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<(RemoteDevice, String)> {
    let created_at_ms = row.get::<_, i64>(3)?;
    let last_seen_at_ms = row.get::<_, i64>(4)?;
    let expires_at_ms = row.get::<_, i64>(5)?;
    let revoked_at_ms = row.get::<_, Option<i64>>(6)?;
    Ok((
        RemoteDevice {
            id: row.get(0)?,
            name: row.get(1)?,
            pair_ip: row.get(2)?,
            scopes: row
                .get::<_, String>(8)?
                .parse::<RemoteScopes>()
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        8,
                        rusqlite::types::Type::Text,
                        error.into(),
                    )
                })?,
            created_at_ms: u64::try_from(created_at_ms).unwrap_or_default(),
            last_seen_at_ms: u64::try_from(last_seen_at_ms).unwrap_or_default(),
            expires_at_ms: u64::try_from(expires_at_ms).unwrap_or_default(),
            revoked_at_ms: revoked_at_ms.and_then(|value| u64::try_from(value).ok()),
        },
        row.get(7)?,
    ))
}

pub(crate) const DEVICE_TOKEN_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const DEVICE_SLIDING_RENEW_THRESHOLD_MS: u64 = 15 * 24 * 60 * 60 * 1_000;

pub(crate) fn authenticate_remote_device(
    db: &SqliteConnection,
    token_hash: &str,
    now_ms: u64,
) -> Result<Option<RemoteDevice>, String> {
    let result = db
        .query_row(
            "SELECT id,name,pair_ip,created_at_ms,last_seen_at_ms,expires_at_ms,revoked_at_ms,token_hash,scopes
             FROM remote_devices
             WHERE token_hash=?1 AND revoked_at_ms IS NULL AND expires_at_ms>=?2",
            params![token_hash, as_i64(now_ms, "authentication time")?],
            row_to_remote_device,
        )
        .optional()
        .map_err(|error| format!("failed to authenticate Remote WebUI device: {error}"))?;
    let Some((mut device, _)) = result else {
        return Ok(None);
    };
    let should_touch = now_ms.saturating_sub(device.last_seen_at_ms) >= 60_000;
    let remaining_ms = device.expires_at_ms.saturating_sub(now_ms);
    let should_slide = remaining_ms < DEVICE_SLIDING_RENEW_THRESHOLD_MS;
    if should_touch || should_slide {
        let next_last_seen = if should_touch {
            now_ms
        } else {
            device.last_seen_at_ms
        };
        let next_expires = if should_slide {
            now_ms.saturating_add(DEVICE_TOKEN_TTL_MS)
        } else {
            device.expires_at_ms
        };
        let updated = db
            .execute(
                "UPDATE remote_devices
                 SET last_seen_at_ms=?1, expires_at_ms=?2
                 WHERE id=?3 AND revoked_at_ms IS NULL AND expires_at_ms>=?4",
                params![
                    as_i64(next_last_seen, "device last-seen time")?,
                    as_i64(next_expires, "device expiry")?,
                    device.id,
                    as_i64(now_ms, "authentication time")?,
                ],
            )
            .map_err(|error| format!("failed to update Remote WebUI device activity: {error}"))?;
        if updated == 0 {
            return Ok(None);
        }
        device.last_seen_at_ms = next_last_seen;
        device.expires_at_ms = next_expires;
    }
    Ok(Some(device))
}

pub(crate) fn list_remote_devices(db: &SqliteConnection) -> Result<Vec<RemoteDevice>, String> {
    let mut statement = db
        .prepare(
            "SELECT id,name,pair_ip,created_at_ms,last_seen_at_ms,expires_at_ms,revoked_at_ms,token_hash,scopes
             FROM remote_devices
             ORDER BY last_seen_at_ms DESC, created_at_ms DESC",
        )
        .map_err(|error| format!("failed to prepare Remote WebUI device query: {error}"))?;
    let rows = statement
        .query_map([], row_to_remote_device)
        .map_err(|error| format!("failed to list Remote WebUI devices: {error}"))?;
    let mut devices = Vec::new();
    for row in rows {
        devices.push(
            row.map_err(|error| format!("failed to decode Remote WebUI device: {error}"))?
                .0,
        );
    }
    Ok(devices)
}

pub(crate) fn revoke_remote_device(
    db: &SqliteConnection,
    device_id: &str,
    now_ms: u64,
) -> Result<bool, String> {
    let changed = db
        .execute(
            "UPDATE remote_devices
             SET revoked_at_ms=?1
             WHERE id=?2 AND revoked_at_ms IS NULL",
            params![as_i64(now_ms, "device revoke time")?, device_id],
        )
        .map_err(|error| format!("failed to revoke Remote WebUI device: {error}"))?;
    Ok(changed > 0)
}

pub(crate) fn set_remote_device_scopes(
    db: &SqliteConnection,
    device_id: &str,
    scopes: RemoteScopes,
) -> Result<bool, String> {
    db.execute(
        "UPDATE remote_devices SET scopes=?1 WHERE id=?2 AND revoked_at_ms IS NULL",
        params![scopes.as_str(), device_id],
    )
    .map(|changed| changed > 0)
    .map_err(|error| format!("failed to change Remote WebUI device scopes: {error}"))
}

pub(crate) fn revoke_all_remote_devices(db: &SqliteConnection, now_ms: u64) -> Result<(), String> {
    db.execute(
        "UPDATE remote_devices SET revoked_at_ms=?1 WHERE revoked_at_ms IS NULL",
        params![as_i64(now_ms, "device revoke time")?],
    )
    .map(|_| ())
    .map_err(|error| format!("failed to revoke Remote WebUI devices: {error}"))
}

/// Returns the new expiry only if the device is still valid.
pub(crate) fn renew_remote_device(
    db: &mut SqliteConnection,
    device_id: &str,
    ttl_ms: u64,
) -> Result<Option<u64>, String> {
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to lock Remote WebUI device state: {error}"))?;
    // The device can expire while waiting for the write lock.
    let now_ms = super::now_ms();
    let expires_at_ms = now_ms.saturating_add(ttl_ms);
    let changed = transaction
        .execute(
            "UPDATE remote_devices
             SET expires_at_ms=?1
             WHERE id=?2 AND revoked_at_ms IS NULL AND expires_at_ms>=?3",
            params![
                as_i64(expires_at_ms, "device expiry")?,
                device_id,
                as_i64(now_ms, "device renew time")?
            ],
        )
        .map_err(|error| format!("failed to renew Remote WebUI device: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit Remote WebUI device renewal: {error}"))?;
    Ok((changed > 0).then_some(expires_at_ms))
}

pub(crate) fn clear_remote_devices(db: &SqliteConnection) -> Result<usize, String> {
    db.execute("DELETE FROM remote_devices", [])
        .map_err(|error| format!("failed to clear Remote WebUI devices: {error}"))
}

pub(crate) fn delete_expired_remote_devices(
    db: &SqliteConnection,
    now_ms: u64,
) -> Result<usize, String> {
    db.execute(
        "DELETE FROM remote_devices WHERE expires_at_ms<?1",
        params![as_i64(now_ms, "device cleanup time")?],
    )
    .map_err(|error| format!("failed to clean expired Remote WebUI devices: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::schema::initialize_schema;

    fn db() -> SqliteConnection {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        initialize_schema(&db).expect("initialize schema");
        db
    }

    #[test]
    fn remote_config_defaults_and_round_trips() {
        let db = db();
        let first = get_remote_host_config(&db).unwrap();
        assert!(!first.enabled);
        assert!((10_000..=65_535).contains(&first.port));
        // 首次生成的随机端口必须落库,后续读取保持稳定。
        assert_eq!(get_remote_host_config(&db).unwrap(), first);
        let config = RemoteHostConfig {
            enabled: true,
            port: 48_001,
            public_base_url: "https://dev.example.com".to_owned(),
        };
        set_remote_host_config(&db, &config).unwrap();
        assert_eq!(get_remote_host_config(&db).unwrap(), config);
    }

    #[test]
    fn old_remote_devices_and_pairing_migrate_to_chat() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE remote_pairing (
                id INTEGER PRIMARY KEY, secret_hash TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
                consumed_at_ms INTEGER
             );
             INSERT INTO remote_pairing VALUES(1, 'pair-hash', 100, NULL);
             CREATE TABLE remote_devices (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
                created_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER
             );
             INSERT INTO remote_devices VALUES('legacy', 'Legacy', 'token-hash', 10, 10, 100, NULL);",
        )
        .unwrap();
        initialize_schema(&db).unwrap();
        initialize_schema(&db).unwrap();
        let devices = list_remote_devices(&db).unwrap();
        assert_eq!(devices[0].id, "legacy");
        assert_eq!(devices[0].scopes, RemoteScopes::Chat);
        let scopes: String = db
            .query_row("SELECT scopes FROM remote_pairing", [], |row| row.get(0))
            .unwrap();
        assert_eq!(scopes, "chat");
    }

    #[test]
    fn pairing_is_one_time_and_expires() {
        let mut db = db();
        replace_remote_pairing(&db, "hash", 200, RemoteScopes::Chat).unwrap();
        assert!(!consume_remote_pairing(&mut db, "wrong", 100).unwrap());
        assert!(consume_remote_pairing(&mut db, "hash", 100).unwrap());
        assert!(!consume_remote_pairing(&mut db, "hash", 101).unwrap());

        replace_remote_pairing(&db, "hash-2", 200, RemoteScopes::ChatWorkspace).unwrap();
        assert!(!consume_remote_pairing(&mut db, "hash-2", 201).unwrap());
    }

    #[test]
    fn clearing_remote_devices_removes_all() {
        let db = db();
        let device = RemoteDevice {
            id: "device-1".to_owned(),
            name: "Phone".to_owned(),
            pair_ip: "192.168.1.20".to_owned(),
            scopes: RemoteScopes::ChatWorkspace,
            created_at_ms: 10,
            last_seen_at_ms: 10,
            expires_at_ms: 100,
            revoked_at_ms: None,
        };
        insert_remote_device(&db, &device, "token-hash").unwrap();
        assert_eq!(list_remote_devices(&db).unwrap().len(), 1);
        assert_eq!(list_remote_devices(&db).unwrap()[0].pair_ip, "192.168.1.20");
        assert!(rename_remote_device(&db, "device-1", "My phone").unwrap());
        assert_eq!(list_remote_devices(&db).unwrap()[0].name, "My phone");
        assert!(!rename_remote_device(&db, "missing", "Nope").unwrap());
        assert_eq!(
            list_remote_devices(&db).unwrap()[0].scopes,
            RemoteScopes::ChatWorkspace
        );
        assert!(set_remote_device_scopes(&db, "device-1", RemoteScopes::Chat).unwrap());
        assert_eq!(
            list_remote_devices(&db).unwrap()[0].scopes,
            RemoteScopes::Chat
        );
        assert_eq!(clear_remote_devices(&db).unwrap(), 1);
        assert!(list_remote_devices(&db).unwrap().is_empty());
    }

    #[test]
    fn device_authentication_respects_revoke_and_expiry() {
        let db = db();
        let device = RemoteDevice {
            id: "device-1".to_owned(),
            name: "Phone".to_owned(),
            pair_ip: String::new(),
            scopes: RemoteScopes::ChatWorkspace,
            created_at_ms: 10,
            last_seen_at_ms: 10,
            expires_at_ms: 100,
            revoked_at_ms: None,
        };
        insert_remote_device(&db, &device, "token-hash").unwrap();
        assert!(
            authenticate_remote_device(&db, "token-hash", 50)
                .unwrap()
                .is_some()
        );
        revoke_remote_device(&db, "device-1", 60).unwrap();
        assert!(
            authenticate_remote_device(&db, "token-hash", 61)
                .unwrap()
                .is_none()
        );

        let expired = RemoteDevice {
            id: "device-2".to_owned(),
            name: "Old phone".to_owned(),
            pair_ip: String::new(),
            scopes: RemoteScopes::Chat,
            created_at_ms: 1,
            last_seen_at_ms: 1,
            expires_at_ms: 2,
            revoked_at_ms: None,
        };
        insert_remote_device(&db, &expired, "expired-token").unwrap();
        assert!(
            authenticate_remote_device(&db, "expired-token", 3)
                .unwrap()
                .is_none()
        );
    }
}
