//! argv, environment and launch-arg folds (v1 `makeClaudeQueryOptions`, `ClaudeLaunchArgs.ts`,
//! `ClaudeHome.ts`).

use goat2_contracts::{
    ModelSelection, ProviderOptionSelection, ProviderOptionSelectionValue, RuntimeMode,
};
use goat2_engine_claude::launch::{
    CompiledModel, LaunchOptions, LaunchRequest, PermissionMode, SessionIdentity, build_launch,
};

fn args(launch: &goat2_engine_claude::process::Launch) -> Vec<String> {
    launch
        .args
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

fn model(options: Option<Vec<ProviderOptionSelection>>) -> CompiledModel {
    CompiledModel::compile(&ModelSelection {
        instance_id: "claudeAgent".into(),
        model: "claude-opus-5-5".into(),
        options,
    })
}

#[test]
fn runtime_modes_map_to_v1_permission_modes() {
    assert_eq!(
        PermissionMode::for_runtime_mode(RuntimeMode::ApprovalRequired),
        PermissionMode::Default
    );
    assert_eq!(
        PermissionMode::for_runtime_mode(RuntimeMode::AutoAcceptEdits),
        PermissionMode::AcceptEdits
    );
    assert_eq!(
        PermissionMode::for_runtime_mode(RuntimeMode::Auto),
        PermissionMode::Auto
    );
    assert_eq!(
        PermissionMode::for_runtime_mode(RuntimeMode::FullAccess),
        PermissionMode::BypassPermissions
    );
}

#[test]
fn argv_follows_the_sdk_order_and_options() {
    let model = model(Some(vec![
        ProviderOptionSelection {
            id: "effort".into(),
            value: ProviderOptionSelectionValue::Text("high".into()),
        },
        ProviderOptionSelection {
            id: "fastMode".into(),
            value: ProviderOptionSelectionValue::Flag(true),
        },
    ]));
    let identity = SessionIdentity::New("s-1".into());
    let (launch, folds, mode) = build_launch(
        &LaunchOptions::default(),
        &LaunchRequest {
            cwd: "/tmp",
            model: &model,
            permission_mode: PermissionMode::Default,
            identity: &identity,
            mcp_url: Some("http://127.0.0.1:4555/mcp"),
        },
    )
    .unwrap();
    assert_eq!(mode, PermissionMode::Default);
    assert!(folds.append_system_prompt.is_empty());
    let argv = args(&launch);
    assert_eq!(
        &argv[..5],
        [
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json"
        ]
    );
    let pos = |w: &str| {
        argv.iter()
            .position(|a| a == w)
            .unwrap_or_else(|| panic!("{w} in {argv:?}"))
    };
    assert_eq!(argv[pos("--thinking") + 1], "adaptive");
    assert_eq!(argv[pos("--thinking-display") + 1], "summarized");
    assert_eq!(argv[pos("--effort") + 1], "high");
    assert_eq!(argv[pos("--model") + 1], "claude-opus-5-5");
    assert_eq!(argv[pos("--permission-prompt-tool") + 1], "stdio");
    assert_eq!(argv[pos("--allowedTools") + 1], "mcp__goat__*");
    assert_eq!(argv[pos("--tools") + 1], "default");
    assert_eq!(argv[pos("--permission-mode") + 1], "default");
    assert_eq!(argv[pos("--add-dir") + 1], "/tmp");
    assert!(argv.contains(&"--session-id=s-1".to_string()));
    assert!(!argv.contains(&"--allow-dangerously-skip-permissions".to_string()));
    let settings: serde_json::Value = serde_json::from_str(&argv[pos("--settings") + 1]).unwrap();
    assert_eq!(settings["showThinkingSummaries"], true);
    assert_eq!(settings["fastMode"], true);
    let env: Vec<(String, String)> = launch
        .env_set
        .iter()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect();
    assert!(env.contains(&("CLAUDE_CODE_ENTRYPOINT".into(), "t3-code".into())));
    assert!(
        env.iter()
            .any(|(k, v)| k == "NO_PROXY" && v.split(',').any(|h| h == "127.0.0.1"))
    );
    for removed in [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "NODE_OPTIONS",
        "ELECTRON_RUN_AS_NODE",
        "CODEX_THREAD_ID",
    ] {
        assert!(launch.env_remove.iter().any(|n| n == removed), "{removed}");
    }
    assert!(launch.env_remove_prefixes.iter().any(|p| p == "GOAT_"));
    assert_eq!(launch.nice, 10);
}

#[test]
fn thinking_off_drops_summaries() {
    let model = model(Some(vec![ProviderOptionSelection {
        id: "thinking".into(),
        value: ProviderOptionSelectionValue::Flag(false),
    }]));
    let identity = SessionIdentity::Resume("s-2".into());
    let (launch, _, _) = build_launch(
        &LaunchOptions::default(),
        &LaunchRequest {
            cwd: "",
            model: &model,
            permission_mode: PermissionMode::BypassPermissions,
            identity: &identity,
            mcp_url: None,
        },
    )
    .unwrap();
    let argv = args(&launch);
    assert!(!argv.contains(&"--thinking".to_string()));
    assert!(argv.contains(&"--resume=s-2".to_string()));
    assert!(argv.contains(&"--allow-dangerously-skip-permissions".to_string()));
    assert!(!argv.contains(&"--allowedTools".to_string()));
    assert!(
        launch
            .env_set
            .iter()
            .any(|(k, v)| k == "MCP_CONNECTION_NONBLOCKING" && v == "0")
    );
}

#[test]
fn launch_args_fold_like_v1() {
    let dir = std::env::temp_dir().join(format!("goat2-claude-launch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("extra.md"), "From file\n").unwrap();
    let options = LaunchOptions {
        launch_args: [
            "--append-system-prompt-file",
            "extra.md",
            "--append-system-prompt",
            "From flag",
            "--permission-mode",
            "plan",
            "--add-dir",
            "/opt/shared",
            "--strict-mcp-config",
            "--settings",
            "{\"cleanupPeriodDays\":3}",
        ]
        .map(String::from)
        .to_vec(),
        ..LaunchOptions::default()
    };
    let model = model(None);
    let identity = SessionIdentity::New("s".into());
    let cwd = dir.display().to_string();
    let (launch, folds, mode) = build_launch(
        &options,
        &LaunchRequest {
            cwd: &cwd,
            model: &model,
            permission_mode: PermissionMode::Default,
            identity: &identity,
            mcp_url: None,
        },
    )
    .unwrap();
    assert_eq!(
        folds.append_system_prompt,
        vec!["From file".to_string(), "From flag".to_string()]
    );
    assert_eq!(mode, PermissionMode::Plan, "a launch-arg mode wins");
    let argv = args(&launch);
    assert!(
        !argv.iter().any(|a| a.starts_with("--append-system-prompt")),
        "folded out of argv"
    );
    assert!(
        argv.windows(2)
            .any(|w| w[0] == "--add-dir" && w[1] == "/opt/shared")
    );
    assert!(argv.contains(&"--strict-mcp-config".to_string()));
    let settings_at = argv.iter().position(|a| a == "--settings").unwrap();
    let settings: serde_json::Value = serde_json::from_str(&argv[settings_at + 1]).unwrap();
    assert_eq!(settings["cleanupPeriodDays"], 3);

    let missing = LaunchOptions {
        launch_args: vec!["--append-system-prompt-file".into(), "nope.md".into()],
        ..LaunchOptions::default()
    };
    let error = build_launch(
        &missing,
        &LaunchRequest {
            cwd: &cwd,
            model: &model,
            permission_mode: PermissionMode::Default,
            identity: &identity,
            mcp_url: None,
        },
    )
    .unwrap_err();
    assert!(
        error.starts_with("Claude could not read the --append-system-prompt-file launch argument"),
        "{error}"
    );
    std::fs::remove_dir_all(&dir).ok();
}
