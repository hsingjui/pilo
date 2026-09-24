use std::sync::{Arc, atomic::Ordering};

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
                    process.closed.store(true, Ordering::Release);
                    Arc::clone(process)
                })
                .collect::<Vec<_>>()
        };
        for process in processes {
            process.session.lock().await.stop().await?;
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
                    process.closed.store(true, Ordering::Release);
                    process
                })
                .collect::<Vec<_>>()
        };
        for process in processes {
            let _ = process.session.lock().await.stop().await;
        }
    }
}
