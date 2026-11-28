use serde_json::Value;

use super::{ByteBudget, HostApiError, Principal};

const MAX_CHAT_IMAGES: usize = 8;
const MAX_CHAT_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_CHAT_IMAGE_TOTAL_BYTES: usize = 20 * 1024 * 1024;

pub(super) fn check_json_size(params: &Value, limit: usize) -> Result<(), HostApiError> {
    serde_json::to_writer(ByteBudget(limit), params)
        .map_err(|_| HostApiError::invalid(format!("Host API parameters exceed {limit} bytes")))
}

pub(super) fn validate_rpc(who: &Principal, command: &Value) -> Result<(), String> {
    let command_type = command.get("type").and_then(Value::as_str);
    if matches!(who, Principal::Local) {
        return match command_type {
            Some("prompt" | "steer" | "follow_up") => validate_images(command, false),
            _ => Ok(()),
        };
    }
    let command_type = command_type.ok_or_else(|| "chat command is missing a type".to_owned())?;
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
        validate_images(command, true)?;
    }
    Ok(())
}

fn validate_images(command: &Value, validate_format: bool) -> Result<(), String> {
    let Some(images) = command.get("images") else {
        return Ok(());
    };
    let Some(images) = images.as_array() else {
        return if validate_format {
            Err("images must be an array".into())
        } else {
            Ok(())
        };
    };
    if images.len() > MAX_CHAT_IMAGES {
        return Err(format!(
            "at most {MAX_CHAT_IMAGES} images can be sent at once"
        ));
    }
    let mut total = 0_usize;
    for image in images {
        if validate_format {
            validate_image_format(image)?;
        }
        let Some(data) = image.get("data").and_then(Value::as_str) else {
            if validate_format {
                return Err("image attachment is missing data".into());
            }
            continue;
        };
        let unpadded = data
            .strip_suffix("==")
            .or_else(|| data.strip_suffix('='))
            .unwrap_or(data);
        let estimated_bytes = unpadded.len().saturating_mul(3) / 4;
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

fn validate_image_format(image: &Value) -> Result<(), String> {
    if image.get("type").and_then(Value::as_str) != Some("image") {
        return Err("Remote WebUI accepts image attachments only".into());
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn device() -> Principal {
        Principal::Device {
            id: "test".into(),
            scopes: pilo_domain::RemoteScopes::Chat,
        }
    }

    #[test]
    fn remote_rpc_rejects_non_chat_commands() {
        assert!(validate_rpc(&device(), &json!({"type":"prompt","message":"hello"})).is_ok());
        assert!(validate_rpc(&device(), &json!({"type":"custom_command"})).is_err());
        assert!(validate_rpc(&Principal::Local, &json!({"type":"custom_command"})).is_ok());
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
        assert!(validate_rpc(&device(), &command).is_err());
        assert!(validate_rpc(&Principal::Local, &command).is_ok());
    }

    #[test]
    fn only_remote_send_commands_enforce_image_format() {
        for command in [
            json!({"type":"get_state", "images":{"opaque":true}}),
            json!({"type":"get_messages", "images":[{"mimeType":"image/svg+xml"}]}),
        ] {
            assert!(validate_rpc(&Principal::Local, &command).is_ok());
            assert!(validate_rpc(&device(), &command).is_ok());
        }
        let command = json!({"type":"prompt", "images":[
            {"type":"image", "mimeType":"image/svg+xml", "data":"YWJj"}
        ]});
        assert!(validate_rpc(&Principal::Local, &command).is_ok());
        assert_eq!(
            validate_rpc(&device(), &command).unwrap_err(),
            "unsupported image type 'image/svg+xml'"
        );
    }

    #[test]
    fn sending_images_enforces_same_count_and_decoded_size_limits() {
        fn image(bytes: usize) -> Value {
            let mut data = "A".repeat((bytes * 4).div_ceil(3));
            data.extend(std::iter::repeat_n('=', (4 - data.len() % 4) % 4));
            json!({"type":"image","mimeType":"image/png","data":data})
        }
        let max = image(MAX_CHAT_IMAGE_BYTES);
        let small = image(1);
        let cases = [
            (vec![small.clone(); MAX_CHAT_IMAGES], None),
            (
                vec![small.clone(); MAX_CHAT_IMAGES + 1],
                Some("at most 8 images can be sent at once"),
            ),
            (vec![max.clone(), max.clone()], None),
            (
                vec![max.clone(), max, small],
                Some("image attachments exceed 20 MB total"),
            ),
            (
                vec![image(MAX_CHAT_IMAGE_BYTES + 1)],
                Some("image attachment exceeds 10 MB"),
            ),
        ];
        for (images, expected) in cases {
            let command = json!({"type":"follow_up","images":images});
            for principal in [Principal::Local, device()] {
                assert_eq!(
                    validate_rpc(&principal, &command).err().as_deref(),
                    expected
                );
            }
        }
    }
}
