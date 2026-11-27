//! Connection settings use Pi's user catalog, never a union of project caches.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use pilo_domain::PiRuntime;

use super::{
    PiloRuntime,
    pi_oneshot::{OneshotEventSink, request},
    server_pi::ServerPiSession,
    storage,
};

const MODEL_CATALOG_TTL: Duration = Duration::from_secs(120);

struct CachedConnectionModels {
    models: Vec<Value>,
    cached_at: Instant,
}

#[derive(Default)]
struct ModelCatalogCache {
    generation: u64,
    entries: HashMap<String, CachedConnectionModels>,
    inflight: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

impl ModelCatalogCache {
    fn invalidate(&mut self, connection_id: &str) {
        self.generation = self.generation.wrapping_add(1);
        // Updating the local connection can affect SSH connections that run Pi locally.
        if connection_id == "local" {
            self.entries.clear();
        } else {
            let suffix = format!("::{connection_id}");
            self.entries.retain(|key, _| !key.ends_with(&suffix));
        }
    }
}

fn cache() -> &'static Mutex<ModelCatalogCache> {
    static CACHE: OnceLock<Mutex<ModelCatalogCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ModelCatalogCache::default()))
}

pub(crate) fn invalidate(connection_id: &str) {
    if let Ok(mut guard) = cache().lock() {
        guard.invalidate(connection_id);
    }
}

pub(crate) async fn load(
    paths: &super::host_paths::HostPaths,
    runtime: &PiloRuntime,
    connection_id: &str,
) -> Result<Vec<Value>, String> {
    let scope = paths
        .database_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cache_key = format!("{scope}::{connection_id}");
    let key_lock = {
        let mut guard = cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = guard.entries.get(&cache_key)
            && entry.cached_at.elapsed() < MODEL_CATALOG_TTL
        {
            return Ok(entry.models.clone());
        }
        Arc::clone(
            guard
                .inflight
                .entry(cache_key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    };
    let _singleflight = key_lock.lock().await;
    let started_generation = if let Ok(guard) = cache().lock() {
        if let Some(entry) = guard.entries.get(&cache_key)
            && entry.cached_at.elapsed() < MODEL_CATALOG_TTL
        {
            return Ok(entry.models.clone());
        }
        Some(guard.generation)
    } else {
        None
    };
    let started = Instant::now();
    super::debug_trace::runtime_trace(
        "model_catalog.connection.begin",
        None,
        None,
        json!({ "connectionId": connection_id }),
    );
    let connection = {
        let db = storage::open(paths)?;
        let connection = if connection_id == "local" {
            storage::ensure_local_connection(&db)?
        } else {
            storage::get_connection(&db, connection_id)?
                .ok_or_else(|| format!("Connection '{connection_id}' was not found"))?
        };
        // SSH workspaces configured to run Pi locally use Local Pi's user catalog.
        if connection.pi_runtime == PiRuntime::Local {
            storage::ensure_local_connection(&db)?
        } else {
            connection
        }
    };
    let mut session = ServerPiSession::default();
    let result = tokio::time::timeout(Duration::from_secs(35), async {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        session
            .spawn_connection(
                Arc::clone(&runtime.servers),
                OneshotEventSink { sender },
                &connection,
            )
            .await?;
        let catalog_started = Instant::now();
        let result = request(
            &session,
            &mut receiver,
            json!({ "type": "get_available_models" }),
        )
        .await
        .and_then(|data| {
            data["models"]
                .as_array()
                .cloned()
                .ok_or_else(|| "Pi model catalog response is missing models".to_owned())
        });
        super::debug_trace::runtime_trace(
            "model_catalog.connection_catalog.end",
            None,
            None,
            json!({
                "connectionId": connection_id,
                "ok": result.is_ok(),
                "elapsedMs": catalog_started.elapsed().as_millis(),
            }),
        );
        let cleanup_started = Instant::now();
        let stopped = session.stop().await;
        super::debug_trace::runtime_trace(
            "model_catalog.connection_cleanup.end",
            None,
            None,
            json!({
                "connectionId": connection_id,
                "ok": stopped.is_ok(),
                "elapsedMs": cleanup_started.elapsed().as_millis(),
            }),
        );
        result
    })
    .await
    .map_err(|_| "Connection model catalog timed out".to_owned())
    .and_then(|result| result);
    super::debug_trace::runtime_trace(
        "model_catalog.connection.end",
        None,
        None,
        json!({
            "connectionId": connection_id,
            "ok": result.is_ok(),
            "elapsedMs": started.elapsed().as_millis(),
            "modelCount": result.as_ref().map(|models| models.len()).ok(),
        }),
    );
    if let Ok(models) = &result
        && let Some(started_generation) = started_generation
        && let Ok(mut guard) = cache().lock()
        && guard.generation == started_generation
    {
        guard.entries.insert(
            cache_key,
            CachedConnectionModels {
                models: models.clone(),
                cached_at: Instant::now(),
            },
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalidate_local_clears_all_entries_and_bumps_generation() {
        let mut cache = ModelCatalogCache::default();
        let initial_gen = cache.generation;
        cache.entries.insert(
            "db::local".to_owned(),
            CachedConnectionModels {
                models: vec![json!({ "id": "m1" })],
                cached_at: Instant::now(),
            },
        );
        cache.entries.insert(
            "db::ssh-local-pi".to_owned(),
            CachedConnectionModels {
                models: vec![json!({ "id": "m2" })],
                cached_at: Instant::now(),
            },
        );

        cache.invalidate("local");

        assert_ne!(cache.generation, initial_gen);
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn invalidate_specific_connection_preserves_other_entries() {
        let mut cache = ModelCatalogCache::default();
        cache.entries.insert(
            "db::ssh-a".to_owned(),
            CachedConnectionModels {
                models: vec![json!({ "id": "a" })],
                cached_at: Instant::now(),
            },
        );
        cache.entries.insert(
            "db::ssh-b".to_owned(),
            CachedConnectionModels {
                models: vec![json!({ "id": "b" })],
                cached_at: Instant::now(),
            },
        );

        cache.invalidate("ssh-a");

        assert!(!cache.entries.contains_key("db::ssh-a"));
        assert!(cache.entries.contains_key("db::ssh-b"));
    }
}
