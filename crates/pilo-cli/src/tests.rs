use super::*;

fn words(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

#[test]
fn default_instance_is_injected_at_build_time() {
    let expected = option_env!("PILO_CLI_APP_ID").unwrap_or("app.hsingjui.pilo.dev");
    assert_eq!(app_id(), expected);
    assert!(pilo_ipc::validate_app_id(app_id()).is_ok());
}

#[test]
fn global_options_parse_anywhere() {
    let options = parse_options(words(&["sessions", "--dev", "list", "--timeout", "2.5"])).unwrap();
    assert!(options.dev);
    assert_eq!(options.timeout, Duration::from_millis(2500));
    assert_eq!(options.command, words(&["sessions", "list"]));
    let options = parse_options(words(&["--timeout=90", "--help"])).unwrap();
    assert_eq!(options.timeout, Duration::from_secs(90));
    assert_eq!(options.command, words(&["help"]));
    assert_eq!(
        parse_options(words(&[])).unwrap().timeout,
        DEFAULT_REQUEST_TIMEOUT
    );
    for bad in ["0", "-1", "abc", "inf", "1e9"] {
        let error = parse_options(words(&["--timeout", bad])).unwrap_err();
        assert_eq!(error.category, error::Category::InvalidInput, "{bad}");
    }
}

#[test]
fn every_documented_command_is_routed_and_unknown_ones_are_not() {
    for (command, write) in [
        ("settings get", false),
        ("settings patch", true),
        ("settings theme get", false),
        ("settings theme set", true),
        ("projects list", false),
        ("projects add", true),
        ("projects remove", true),
        ("sessions list", false),
        ("sessions get", false),
        ("sessions history", false),
        ("sessions status", false),
        ("sessions create", true),
        ("sessions send", true),
        ("sessions abort", true),
        ("sessions stop", true),
        ("sessions archive", true),
        ("sessions restore", true),
        ("sessions delete", true),
        ("sessions update", true),
    ] {
        let parsed = host_command(&words(&command.split(' ').collect::<Vec<_>>()));
        assert_eq!(parsed.map(|(_, w)| w), Some(write), "{command}");
        assert!(HELP.contains(command), "help lacks {command}");
    }
    for command in [
        &["open"][..],
        &["sessions"],
        &["sessions", "resume"],
        &["settings"],
    ] {
        assert!(host_command(&words(command)).is_none(), "{command:?}");
    }
}

#[test]
fn bindings_reject_unknown_and_missing_parameters() {
    let params = m::SESSION_CREATE
        .params(&[
            ("projectId", json!("p")),
            ("sessionId", json!("cli-0")),
            ("message", json!("hi")),
            ("title", Value::Null),
        ])
        .unwrap();
    assert_eq!(
        params,
        json!({"projectId": "p", "sessionId": "cli-0", "message": "hi"})
    );
    assert!(
        m::SESSION_CREATE
            .params(&[("projectId", json!("p"))])
            .is_err()
    );
    assert!(m::PROJECT_LIST.params(&[("bogus", json!(1))]).is_err());
    assert_eq!(m::PROTOCOL_VERSION, pilo_ipc::PROTOCOL_VERSION);
}

#[test]
fn flags_and_positionals_are_validated() {
    let args = Args::parse(
        &words(&["abc", "--project", "p1", "--limit=5"]),
        &["project", "limit"],
    )
    .unwrap();
    assert_eq!(args.id("session ID").unwrap(), "abc");
    assert_eq!(args.required("project").unwrap(), "p1");
    assert_eq!(args.count("limit").unwrap(), json!(5));
    assert!(args.count("offset").unwrap().is_null());
    assert!(Args::parse(&words(&["--path"]), &["path"]).is_err());
    assert!(Args::parse(&words(&["--nope", "x"]), &["path"]).is_err());
    let args = Args::parse(&words(&["a", "b"]), &[]).unwrap();
    assert!(args.id("session ID").is_err());
    assert!(args.none().is_err());
    let args = Args::parse(&words(&["--limit", "x"]), &["limit"]).unwrap();
    assert!(args.count("limit").is_err());
}

#[test]
fn stdin_objects_are_strict() {
    let object = parse_object(r#"{"message":"hi","title":"t"}"#, &["message", "title"]).unwrap();
    assert_eq!(text_field(&object, "message", true).unwrap(), json!("hi"));
    assert!(parse_object(r#"{"message":"hi","extra":1}"#, &["message"]).is_err());
    assert!(parse_object("[1]", &["message"]).is_err());
    assert!(parse_object("not json", &["message"]).is_err());
    let object = parse_object(r#"{"message":5}"#, &["message"]).unwrap();
    assert!(text_field(&object, "message", true).is_err());
    let object = parse_object("{}", &["message", "title"]).unwrap();
    assert!(text_field(&object, "message", true).is_err());
    assert!(text_field(&object, "title", false).unwrap().is_null());
}

#[test]
fn new_session_ids_are_unique_and_host_formatted() {
    let first = new_session_id().unwrap();
    assert_ne!(first, new_session_id().unwrap());
    let hex = first.strip_prefix("cli-").unwrap();
    assert_eq!(hex.len(), 32);
    assert!(
        hex.bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
    let mut error = CliError::outcome_unknown("lost");
    error.session_id = Some(first.clone());
    assert_eq!(error.to_json()["error"]["sessionId"], json!(first));
    assert!(
        CliError::invalid("x").to_json()["error"]
            .get("sessionId")
            .is_none()
    );
}

#[test]
fn host_errors_map_to_stable_categories() {
    use error::Category::*;
    let category = |code: &str, write: bool| {
        CliError::from_host(&json!({"code": code, "message": "m"}), write).category
    };
    assert_eq!(category("invalid_params", true), InvalidInput);
    assert_eq!(category("not_found", false), Rejected);
    assert_eq!(category("conflict", true), Rejected);
    assert_eq!(category("unsupported_method", false), Rejected);
    assert_eq!(category("incompatible_protocol", false), Incompatible);
    assert_eq!(category("outcome_unknown", true), OutcomeUnknown);
    assert_eq!(category("timeout", true), OutcomeUnknown);
    assert_eq!(category("timeout", false), Offline);
    assert_eq!(category("unavailable", false), Offline);
    assert_eq!(category("internal", false), Internal);
    let codes: Vec<i32> = [
        InvalidInput,
        Offline,
        Incompatible,
        Rejected,
        OutcomeUnknown,
        Internal,
    ]
    .iter()
    .map(|category| category.exit_code())
    .collect();
    assert!(codes.iter().all(|code| *code != 0));
    let mut unique = codes.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), codes.len());
}

#[test]
fn open_targets_resolve_against_the_callers_cwd() {
    assert_eq!(open_target(&words(&[])).unwrap(), OpenTarget::App);
    assert_eq!(
        open_target(&words(&["--session", "0198-ab"])).unwrap(),
        OpenTarget::Session("0198-ab".into())
    );
    let cwd = std::path::Path::new("/work/some dir");
    assert_eq!(
        resolve_directory(cwd, "my project").unwrap(),
        std::path::PathBuf::from("/work/some dir/my project")
    );
    assert_eq!(
        resolve_directory(cwd, "/abs").unwrap(),
        std::path::PathBuf::from("/abs")
    );
    for bad in [
        &["a", "b"][..],
        &[".", "--session", "x"],
        &["--session", " "],
        &["--project", "x"],
    ] {
        let error = open_target(&words(bad)).unwrap_err();
        assert_eq!(error.category, error::Category::InvalidInput, "{bad:?}");
    }
}

#[test]
fn launch_is_a_global_option() {
    let options = parse_options(words(&["projects", "list", "--launch"])).unwrap();
    assert!(options.launch);
    assert_eq!(options.command, words(&["projects", "list"]));
}
