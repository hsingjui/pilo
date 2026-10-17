mod appearance;
pub use appearance::{ThemeSettings, ThemeSettingsUpdate};
mod cache_keep_alive;
pub use cache_keep_alive::{CacheKeepAliveSettings, CacheKeepAliveStatus};
mod connection;
mod desktop;
pub(crate) use desktop::{AutostartMode, DEFAULT_SHOW_SHORTCUT};
mod next_prompt;
mod project;
mod prompt_enhance;
pub use next_prompt::{NextPromptModel, NextPromptRequest, NextPromptSettings};
pub use prompt_enhance::PromptEnhanceModel;
mod remote;
mod session;

pub use connection::{
    Connection, ConnectionKind, ConnectionNamingModel, PiRuntime, SshAuthMethod, SshTarget,
    WslDistribution,
};
pub use project::{
    DiscoveredProject, Project, ProjectMetadata, ProjectModelCache, ProjectModelScope,
    ProjectScopedModel,
};
pub use remote::{
    RemoteAccessAddress, RemoteAccessConfig, RemoteDevice, RemoteHostConfig, random_remote_port,
};
pub use session::{
    SessionIndexEntry, SessionReadState, SessionReconcileResult, SessionUiStateUpdate,
};
