use serde_json::Value;

const MAX_CHAT_IMAGES: usize = 8;
const MAX_CHAT_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_CHAT_IMAGE_TOTAL_BYTES: usize = 20 * 1024 * 1024;

pub(super) fn validate_remote_rpc(command: &Value) -> Result<(), String> {
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "chat command is missing a type".to_owned())?;
    const ALLOWED: &[&str] = &[
        "prompt",
        "steer",
        "follow_up",
        "abort",
        "get_state",
        "get_messages",
        "get_entries",
        "get_session_stats",
        "get_commands",
        "get_available_models",
        "get_available_thinking_levels",
        "set_model",
        "cycle_model",
        "set_thinking_level",
        "set_session_name",
        "fork",
        "clone",
        "compact",
        "abort_retry",
        "clear_queue",
        "extension_ui_response",
    ];
    if !ALLOWED.contains(&command_type) {
        return Err(format!(
            "chat command '{command_type}' is not available over Remote WebUI"
        ));
    }
    if matches!(command_type, "prompt" | "steer" | "follow_up") {
        validate_remote_images(command)?;
    }
    Ok(())
}

fn validate_remote_images(command: &Value) -> Result<(), String> {
    let Some(images) = command.get("images") else {
        return Ok(());
    };
    let images = images
        .as_array()
        .ok_or_else(|| "images must be an array".to_owned())?;
    if images.len() > MAX_CHAT_IMAGES {
        return Err(format!(
            "at most {MAX_CHAT_IMAGES} images can be sent at once"
        ));
    }
    let mut total = 0_usize;
    for image in images {
        if image.get("type").and_then(Value::as_str) != Some("image") {
            return Err("Remote WebUI accepts image attachments only".to_owned());
        }
        let mime = image
            .get("mimeType")
            .and_then(Value::as_str)
            .ok_or_else(|| "image attachment is missing mimeType".to_owned())?;
        if !matches!(
            mime,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) {
            return Err(format!("unsupported image type '{mime}'"));
        }
        let data = image
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "image attachment is missing data".to_owned())?;
        let estimated_bytes = data.len().saturating_mul(3) / 4;
        if estimated_bytes > MAX_CHAT_IMAGE_BYTES {
            return Err("image attachment exceeds 10 MB".to_owned());
        }
        total = total.saturating_add(estimated_bytes);
    }
    if total > MAX_CHAT_IMAGE_TOTAL_BYTES {
        return Err("image attachments exceed 20 MB total".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remote_rpc_rejects_non_chat_commands() {
        assert!(validate_remote_rpc(&json!({"type":"prompt","message":"hello"})).is_ok());
        assert!(validate_remote_rpc(&json!({"type":"terminal_write","data":"whoami"})).is_err());
        assert!(validate_remote_rpc(&json!({"type":"fs_read_file","path":"/tmp/a"})).is_err());
    }

    #[test]
    fn remote_rpc_rejects_generic_file_attachments() {
        let command = json!({
            "type": "prompt",
            "message": "inspect this",
            "images": [{
                "type": "file",
                "mimeType": "text/plain",
                "data": "aGVsbG8="
            }]
        });
        assert!(validate_remote_rpc(&command).is_err());
    }
}
