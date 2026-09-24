use rusqlite::{Connection as SqliteConnection, OptionalExtension, TransactionBehavior, params};

use crate::domain::{RemoteDevice, RemoteHostConfig};

fn as_i64(value: u64, field: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("{field} is out of SQLite integer range"))
}

pub(crate) fn get_remote_host_config(db: &SqliteConnection) -> Result<RemoteHostConfig, String> {
    db.query_row(
        "SELECT enabled, port FROM remote_host_config WHERE id=1",
        [],
        |row| {
            Ok(RemoteHostConfig {
                enabled: row.get::<_, i64>(0)? != 0,
                port: row.get::<_, u16>(1)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("failed to read Remote WebUI configuration: {error}"))
    .map(|value| value.unwrap_or_default())
}

pub(crate) fn set_remote_host_config(
    db: &SqliteConnection,
    config: &RemoteHostConfig,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO remote_host_config(id,enabled,port)
         VALUES(1,?1,?2)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, port=excluded.port",
        params![i64::from(config.enabled), config.port],
    )
    .map_err(|error| format!("failed to persist Remote WebUI configuration: {error}"))?;
    Ok(())
}

pub(crate) fn replace_remote_pairing(
    db: &SqliteConnection,
    secret_hash: &str,
    expires_at_ms: u64,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO remote_pairing(id,secret_hash,expires_at_ms,consumed_at_ms)
         VALUES(1,?1,?2,NULL)
         ON CONFLICT(id) DO UPDATE SET
           secret_hash=excluded.secret_hash,
           expires_at_ms=excluded.expires_at_ms,
           consumed_at_ms=NULL",
        params![secret_hash, as_i64(expires_at_ms, "pairing expiry")?],
    )
    .map_err(|error| format!("failed to persist Remote WebUI pairing secret: {error}"))?;
    Ok(())
}

pub(crate) fn clear_remote_pairing(db: &SqliteConnection) -> Result<(), String> {
    db.execute("DELETE FROM remote_pairing WHERE id=1", [])
        .map_err(|error| format!("failed to clear Remote WebUI pairing secret: {error}"))?;
    Ok(())
}

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
           id,name,token_hash,created_at_ms,last_seen_at_ms,expires_at_ms,revoked_at_ms
         ) VALUES(?1,?2,?3,?4,?5,?6,NULL)",
        params![
            device.id,
            device.name,
            token_hash,
            as_i64(device.created_at_ms, "device created time")?,
            as_i64(device.last_seen_at_ms, "device last-seen time")?,
            as_i64(device.expires_at_ms, "device expiry")?,
        ],
    )
    .map_err(|error| format!("failed to persist Remote WebUI device: {error}"))?;
    Ok(())
}

fn row_to_remote_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<(RemoteDevice, String)> {
    let created_at_ms = row.get::<_, i64>(2)?;
    let last_seen_at_ms = row.get::<_, i64>(3)?;
    let expires_at_ms = row.get::<_, i64>(4)?;
    let revoked_at_ms = row.get::<_, Option<i64>>(5)?;
    Ok((
        RemoteDevice {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at_ms: u64::try_from(created_at_ms).unwrap_or_default(),
            last_seen_at_ms: u64::try_from(last_seen_at_ms).unwrap_or_default(),
            expires_at_ms: u64::try_from(expires_at_ms).unwrap_or_default(),
            revoked_at_ms: revoked_at_ms.and_then(|value| u64::try_from(value).ok()),
        },
        row.get(6)?,
    ))
}

pub(crate) fn authenticate_remote_device(
    db: &SqliteConnection,
    token_hash: &str,
    now_ms: u64,
) -> Result<Option<RemoteDevice>, String> {
    let result = db
        .query_row(
            "SELECT id,name,created_at_ms,last_seen_at_ms,expires_at_ms,revoked_at_ms,token_hash
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
    if now_ms.saturating_sub(device.last_seen_at_ms) >= 60_000 {
        db.execute(
            "UPDATE remote_devices SET last_seen_at_ms=?1 WHERE id=?2",
            params![as_i64(now_ms, "device last-seen time")?, device.id],
        )
        .map_err(|error| format!("failed to update Remote WebUI device activity: {error}"))?;
        device.last_seen_at_ms = now_ms;
    }
    Ok(Some(device))
}

pub(crate) fn list_remote_devices(db: &SqliteConnection) -> Result<Vec<RemoteDevice>, String> {
    let mut statement = db
        .prepare(
            "SELECT id,name,created_at_ms,last_seen_at_ms,expires_at_ms,revoked_at_ms,token_hash
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
    use crate::runtime::storage::schema::initialize_schema;

    fn db() -> SqliteConnection {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        initialize_schema(&db).expect("initialize schema");
        db
    }

    #[test]
    fn remote_config_defaults_and_round_trips() {
        let db = db();
        assert_eq!(
            get_remote_host_config(&db).unwrap(),
            RemoteHostConfig::default()
        );
        let config = RemoteHostConfig {
            enabled: true,
            port: 48_001,
        };
        set_remote_host_config(&db, &config).unwrap();
        assert_eq!(get_remote_host_config(&db).unwrap(), config);
    }

    #[test]
    fn pairing_is_one_time_and_expires() {
        let mut db = db();
        replace_remote_pairing(&db, "hash", 200).unwrap();
        assert!(!consume_remote_pairing(&mut db, "wrong", 100).unwrap());
        assert!(consume_remote_pairing(&mut db, "hash", 100).unwrap());
        assert!(!consume_remote_pairing(&mut db, "hash", 101).unwrap());

        replace_remote_pairing(&db, "hash-2", 200).unwrap();
        assert!(!consume_remote_pairing(&mut db, "hash-2", 201).unwrap());
    }

    #[test]
    fn device_authentication_respects_revoke_and_expiry() {
        let db = db();
        let device = RemoteDevice {
            id: "device-1".to_owned(),
            name: "Phone".to_owned(),
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
