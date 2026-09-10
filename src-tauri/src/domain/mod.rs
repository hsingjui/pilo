mod connection;
mod workspace;

pub use connection::{
    Connection, ConnectionKind, LocalConnection, LocalEnvironmentInfo, SshConnection,
    SshEnvironmentInfo, SshTarget, WslConnection, WslDistribution, WslEnvironmentInfo,
};
pub use workspace::{DiscoveredWorkspace, Workspace, WorkspaceMetadata};
