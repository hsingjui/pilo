use std::sync::Arc;

use tokio::task::JoinSet;

use super::ChatSessions;

impl ChatSessions {
    pub async fn open_project(&self, project_id: &str) -> Result<(), String> {
        let mut registry = self.registry.lock().await;
        if registry.shutting_down || registry.unavailable_projects.get(project_id) == Some(&true) {
            return Err("project is still closing".to_owned());
        }
        registry.unavailable_projects.remove(project_id);
        Ok(())
    }

    pub async fn stop_project(&self, project_id: &str) -> Result<(), String> {
        let processes = {
            let mut registry = self.registry.lock().await;
            registry
                .unavailable_projects
                .insert(project_id.to_owned(), true);
            registry
                .processes
                .values()
                .filter(|process| process.project_id == project_id)
                .map(|process| {
                    process.mark_closed();
                    Arc::clone(process)
                })
                .collect::<Vec<_>>()
        };
        let mut stops = JoinSet::new();
        for process in processes {
            stops.spawn(async move { process.session.lock().await.stop().await });
        }
        let mut stop_error = None;
        while let Some(result) = stops.join_next().await {
            if let Err(error) = result.unwrap_or_else(|error| Err(error.to_string())) {
                stop_error.get_or_insert(error);
            }
        }
        if let Some(error) = stop_error {
            return Err(error);
        }
        let mut registry = self.registry.lock().await;
        registry
            .processes
            .retain(|_, process| process.project_id != project_id);
        registry
            .unavailable_projects
            .insert(project_id.to_owned(), false);
        Ok(())
    }

    pub async fn stop_all(&self) {
        let processes = {
            let mut registry = self.registry.lock().await;
            registry.shutting_down = true;
            registry
                .processes
                .drain()
                .map(|(_, process)| {
                    process.mark_closed();
                    process
                })
                .collect::<Vec<_>>()
        };
        for process in processes {
            let _ = process.session.lock().await.stop().await;
        }
    }
}
