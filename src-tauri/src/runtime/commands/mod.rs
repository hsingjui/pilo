mod preferences;
pub use preferences::{preferences_get, preferences_patch};
mod appearance;
mod cache_keep_alive;
mod connections;
mod next_prompt;
mod projects;
mod prompt_enhancement;
pub use next_prompt::{next_prompt_request, next_prompt_settings_get, next_prompt_settings_set};
pub use prompt_enhancement::{
    prompt_enhance, prompt_enhancement_settings_get, prompt_enhancement_settings_set,
};
mod remote;
mod runtime;
mod session_reads;
mod sessions;

pub use session_reads::{session_mark_read, session_read_states};

pub use appearance::{system_font_families, theme_settings_get, theme_settings_set};
pub use cache_keep_alive::{cache_keep_alive_settings_list, cache_keep_alive_settings_set};

pub use connections::{
    SaveSshConnectionRequest, connection_health_get, connection_naming_model_get,
    connection_naming_model_list, connection_naming_model_set, connection_pi_probe,
    connection_settings_update, connection_shown_in_home_set, local_connection_get,
    local_connection_test, ssh_connection_list, ssh_connection_password_get, ssh_connection_remove,
    ssh_connection_save, ssh_connection_test, ssh_connection_test_draft, wsl_connection_list,
    wsl_connection_remove, wsl_connection_save, wsl_connection_test, wsl_list_distributions,
};
pub use projects::{
    connection_fs_read_dir, local_pick_project_directory, parallel_agent_create,
    parallel_agent_list, parallel_agent_remove, parallel_agent_send, parallel_agent_stop,
    project_add, project_chat_file_remove, project_chat_file_upload, project_discover,
    project_file_link_open, project_fs_mkdir, project_fs_read_dir, project_fs_read_file,
    project_fs_read_image, project_fs_remove, project_fs_rename, project_fs_search,
    project_fs_stat, project_fs_write_file, project_git_diff, project_git_status,
    project_html_report_open, project_list, project_model_cache_list, project_model_cache_set,
    project_model_scope_get, project_model_scope_set, project_open_in_zed_wsl,
    project_preview_close, project_preview_open, project_preview_ports, project_refresh,
    project_remove, project_reorder, project_terminal_open, project_touch, terminal_close,
    terminal_resize, terminal_write,
};
pub use remote::{
    remote_device_rename, remote_device_revoke, remote_host_state, remote_lan_addresses,
    remote_pairing_regenerate, remote_set_addresses, remote_set_enabled, remote_set_port,
    remote_set_public_base_url,
};
pub use runtime::{
    chat_session_detach, chat_session_prepare, chat_session_send_rpc, chat_session_start,
    chat_session_state, chat_session_states, chat_session_stop, project_mcp_server_approve,
    project_start_pi, runtime_abort_pi, runtime_get_pi_state, runtime_restart_pi, runtime_send_rpc,
    runtime_stop_pi, runtime_subscribe_events,
};
pub use sessions::{
    generate_session_title, session_delete, session_external_activity, session_generate_title,
    session_history, session_history_image, session_list, session_reconcile, session_search,
    session_update_ui_state, session_watch_start, session_watch_stop,
};
