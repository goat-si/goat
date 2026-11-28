//! The `claude` command line and environment for one thread's process.
//!
//! Ported from GOAT v1 (origin/dev 916b5ccc):
//! - argv order and flags: the Agent SDK's `ProcessTransport.initialize` (`sdk.mjs` 0.3.276) fed by
//!   `makeClaudeQueryOptions` (`ClaudeAdapterV2.ts:575-760`): stream-json in and out, `--verbose`,
//!   adaptive thinking with summarized display unless thinking is off, `--effort`, `--model`,
//!   `--permission-prompt-tool stdio` (v1 always installs `canUseTool`, `ClaudeAdapterV2.ts:9020`),
//!   `--resume=<id>` or `--session-id=<id>` (`ClaudeAdapterV2.ts:629-631`), `--allowedTools mcp__goat__*`
//!   (`claudeMcpQueryOverrides`, `ClaudeAdapterV2.ts:778-830`), `--tools default` (the `claude_code`
//!   preset), `--permission-mode` and `--allow-dangerously-skip-permissions`,
//!   `--include-partial-messages`, `--add-dir <cwd>`, extra launch args, then `--settings`.
//! - permission mode per runtime mode: `permissionModeForClaudeRuntimePolicy`
//!   (`ClaudeAdapterV2.ts:1338-1384`) with no interaction mode, approval or sandbox policy.
//! - launch-arg folds: `makeClaudeQueryOptions` (`ClaudeAdapterV2.ts:606-621,674-679`) and
//!   `readClaudeAppendSystemPromptFile` (`ClaudeLaunchArgs.ts:56-90`).
//! - environment: `mergeClaudeProcessEnvironment` (`provider/Drivers/ClaudeHome.ts:49-89`), the SDK's
//!   `NODE_OPTIONS`/`DEBUG` removal, `claudeMcpProxyBypassEnvironment` (`claudeMcpProxyBypass.ts`)
//!   and `MCP_CONNECTION_NONBLOCKING=0` on resume (`claudeQueryEnvironment`, `ClaudeAdapterV2.ts:533-556`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use goat2_contracts::{ModelSelection, ProviderOptionSelectionValue, RuntimeMode};
use serde_json::{Map, Value, json};

use crate::process::Launch;

/// Claude Code permission modes (`sdk.d.ts` `PermissionMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Auto,
    BypassPermissions,
    Plan,
    DontAsk,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Auto => "auto",
            Self::BypassPermissions => "bypassPermissions",
            Self::Plan => "plan",
            Self::DontAsk => "dontAsk",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "default" => Self::Default,
            "acceptEdits" => Self::AcceptEdits,
            "auto" => Self::Auto,
            "bypassPermissions" => Self::BypassPermissions,
            "plan" => Self::Plan,
            "dontAsk" => Self::DontAsk,
            _ => return None,
        })
    }

    /// v1 `permissionModeForClaudeRuntimePolicy` when only `runtimeMode` is set.
    pub fn for_runtime_mode(mode: RuntimeMode) -> Self {
        match mode {
            RuntimeMode::ApprovalRequired => Self::Default,
            RuntimeMode::AutoAcceptEdits => Self::AcceptEdits,
            RuntimeMode::Auto => Self::Auto,
            RuntimeMode::FullAccess => Self::BypassPermissions,
        }
    }
}

/// The model part of a v1 `ModelSelection` as Claude Code takes it (v1
/// `compileClaudeModelSelection`, `claudeModelOptions.ts:31-79`, without the model catalog:
/// the model id goes through as written and only the `effort`, `thinking` and `fastMode` options
/// are read).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledModel {
    pub api_model_id: String,
    pub effort: Option<String>,
    /// Claude settings from the options (`alwaysThinkingEnabled`, `fastMode`).
    pub settings: Vec<(String, bool)>,
}

impl CompiledModel {
    pub fn compile(selection: &ModelSelection) -> Self {
        let option = |id: &str| {
            selection
                .options
                .iter()
                .flatten()
                .find(|option| option.id == id)
                .map(|option| &option.value)
        };
        let effort = match option("effort") {
            Some(ProviderOptionSelectionValue::Text(value)) if !value.trim().is_empty() => {
                Some(value.trim().to_string())
            }
            _ => None,
        };
        let mut settings = Vec::new();
        if let Some(ProviderOptionSelectionValue::Flag(value)) = option("thinking") {
            settings.push(("alwaysThinkingEnabled".to_string(), *value));
        }
        if let Some(ProviderOptionSelectionValue::Flag(value)) = option("fastMode") {
            settings.push(("fastMode".to_string(), *value));
        }
        Self {
            api_model_id: selection.model.trim().to_string(),
            effort,
            settings,
        }
    }

    fn thinking_enabled(&self) -> bool {
        !self
            .settings
            .iter()
            .any(|(key, value)| key == "alwaysThinkingEnabled" && !value)
    }
}

/// New session with a GOAT-chosen id, or resume of an existing one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionIdentity {
    New(String),
    Resume(String),
}

impl SessionIdentity {
    pub fn id(&self) -> &str {
        match self {
            Self::New(id) | Self::Resume(id) => id,
        }
    }
}

/// How the driver starts `claude` (v1 `ClaudeSettings.binaryPath`, `launchArgs`, instance env).
#[derive(Debug, Clone)]
pub struct LaunchOptions {
    /// Program to run; `claude` on PATH by default.
    pub binary: PathBuf,
    /// Extra arguments (v1 `launchArgs`, already split into words).
    pub launch_args: Vec<String>,
    /// Instance environment, applied last (v1 `mergeProviderInstanceEnvironment`). Set
    /// `CLAUDE_CONFIG_DIR` here to give GOAT its own Claude home.
    pub env: Vec<(String, String)>,
    pub nice: i32,
    pub kill_grace: Duration,
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("claude"),
            launch_args: Vec::new(),
            env: Vec::new(),
            nice: 10,
            kill_grace: Duration::from_secs(5),
        }
    }
}

/// One launch of the CLI.
#[derive(Debug, Clone)]
pub struct LaunchRequest<'a> {
    pub cwd: &'a str,
    pub model: &'a CompiledModel,
    pub permission_mode: PermissionMode,
    pub identity: &'a SessionIdentity,
    /// GOAT MCP endpoint URL, for the proxy exemption.
    pub mcp_url: Option<&'a str>,
}

/// What the launch arguments fold into the session instead of argv.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchFolds {
    /// `--append-system-prompt-file` text, then `--append-system-prompt` (v1 order).
    pub append_system_prompt: Vec<String>,
    /// `--permission-mode` / `--dangerously-skip-permissions` from the launch arguments.
    pub permission_mode: Option<PermissionMode>,
    /// The `--settings` object from the launch arguments (v1 `launchArgSettings`).
    pub settings: Map<String, Value>,
}

/// v1 `CLAUDE_HOST_SESSION_VARIABLES` (`ClaudeHome.ts:49-63`) plus the SDK's removals.
pub(crate) const REMOVED_ENV: [&str; 15] = [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_DESKTOP_APP_VERSION",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "CLAUDE_AGENT_SDK_VERSION",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "DEBUG",
];

/// GOAT's own agent identity must not leak into the Claude child (same rule as the Codex driver).
pub(crate) const REMOVED_ENV_PREFIXES: [&str; 2] = ["GOAT_", "T3CODE_"];
pub(crate) const REMOVED_HOST_IDENTITY: [&str; 5] = [
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_TOOL_CALL_ID",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    // The GOAT 2 host's UI bearer token: agent commands must never see it (as in the Codex
    // driver's process.rs).
    "GOAT2_HOST_TOKEN",
];

/// v1 `CLAUDE_GOAT_MCP_TOOL_WILDCARD`.
pub const GOAT_MCP_TOOL_WILDCARD: &str = "mcp__goat__*";

/// Split launch args into flags the driver folds and the rest, in order (v1 `parseCliArgs` with
/// `claudeLaunchArgParseOptions`: `--flag value`, `--flag=value`, bare boolean flags).
fn parse_launch_args(args: &[String]) -> Vec<(String, Option<String>, Vec<String>)> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let word = &args[index];
        index += 1;
        let Some(flag) = word.strip_prefix("--") else {
            // A stray positional stays where it was.
            out.push((String::new(), None, vec![word.clone()]));
            continue;
        };
        if let Some((name, value)) = flag.split_once('=') {
            out.push((
                name.to_string(),
                Some(value.to_string()),
                vec![word.clone()],
            ));
            continue;
        }
        let takes_value = index < args.len() && !args[index].starts_with("--");
        if takes_value && flag != "dangerously-skip-permissions" {
            let value = args[index].clone();
            index += 1;
            out.push((
                flag.to_string(),
                Some(value.clone()),
                vec![word.clone(), value],
            ));
        } else {
            out.push((flag.to_string(), None, vec![word.clone()]));
        }
    }
    out
}

/// Build the process launch. Errors carry v1's wording and mean nothing was started.
pub fn build_launch(
    options: &LaunchOptions,
    request: &LaunchRequest<'_>,
) -> Result<(Launch, LaunchFolds, PermissionMode), String> {
    let mut folds = LaunchFolds::default();
    let mut passthrough: Vec<String> = Vec::new();
    let mut add_dirs: Vec<String> = Vec::new();
    let mut settings = Map::new();
    let mut thinking_display: Option<String> = None;
    let mut launch_append: Option<String> = None;
    for (name, value, words) in parse_launch_args(&options.launch_args) {
        match name.as_str() {
            "permission-mode" => {
                folds.permission_mode = value.as_deref().and_then(PermissionMode::parse);
            }
            "dangerously-skip-permissions" => {
                if value.is_none() || value.as_deref() == Some("true") {
                    folds.permission_mode = folds
                        .permission_mode
                        .or(Some(PermissionMode::BypassPermissions));
                }
            }
            "append-system-prompt" => match value {
                Some(text) => launch_append = Some(text),
                None => {
                    return Err("The --append-system-prompt launch argument has no text. Add it after the flag in the Claude launch arguments, then send the message again.".to_string());
                }
            },
            "append-system-prompt-file" => {
                let file = value.unwrap_or_default();
                if file.is_empty() {
                    return Err("The --append-system-prompt-file launch argument has no file path. Add it after the flag in the Claude launch arguments, then send the message again.".to_string());
                }
                let path = resolve_path(request.cwd, &file);
                let text = std::fs::read_to_string(&path).map_err(|_| {
                    format!(
                        "Claude could not read the --append-system-prompt-file launch argument at {}. Fix the path in the Claude launch arguments, then send the message again.",
                        path.display()
                    )
                })?;
                let text = text
                    .strip_suffix("\r\n")
                    .or_else(|| text.strip_suffix('\n'))
                    .unwrap_or(&text)
                    .to_string();
                folds.append_system_prompt.insert(0, text);
            }
            "settings" => {
                let raw = value.unwrap_or_default();
                let trimmed = raw.trim();
                let parsed: Option<Value> = if trimmed.starts_with('{') {
                    serde_json::from_str(trimmed).ok()
                } else if trimmed.is_empty() {
                    None
                } else {
                    std::fs::read_to_string(resolve_path(request.cwd, trimmed))
                        .ok()
                        .and_then(|text| serde_json::from_str(&text).ok())
                };
                match parsed {
                    Some(Value::Object(map)) => settings.extend(map),
                    _ => {
                        return Err("Claude could not read the --settings launch argument as a JSON object. Fix it in the Claude launch arguments, then send the message again.".to_string());
                    }
                }
            }
            "add-dir" => add_dirs.extend(value),
            "thinking-display" => thinking_display = value,
            _ => passthrough.extend(words),
        }
    }
    if let Some(text) = launch_append.filter(|text| !text.is_empty()) {
        folds.append_system_prompt.push(text);
    }
    folds.append_system_prompt.retain(|text| !text.is_empty());

    let permission_mode = folds.permission_mode.unwrap_or(request.permission_mode);
    folds.settings = settings.clone();
    let model = request.model;
    for (key, value) in &model.settings {
        settings.insert(key.clone(), json!(value));
    }
    // v1: thinking summaries unless thinking is off or the launch args omit them.
    let summaries = model.thinking_enabled() && thinking_display.as_deref() != Some("omitted");

    let mut args: Vec<String> = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
    ]
    .map(String::from)
    .to_vec();
    if summaries {
        args.extend(
            ["--thinking", "adaptive", "--thinking-display", "summarized"].map(String::from),
        );
        settings.insert("showThinkingSummaries".into(), json!(true));
    } else if let Some(display) = &thinking_display {
        args.extend(["--thinking-display".to_string(), display.clone()]);
    }
    if let Some(effort) = &model.effort {
        args.extend(["--effort".to_string(), effort.clone()]);
    }
    if !model.api_model_id.is_empty() {
        args.extend(["--model".to_string(), model.api_model_id.clone()]);
    }
    args.extend(["--permission-prompt-tool", "stdio"].map(String::from));
    if let SessionIdentity::Resume(id) = request.identity {
        args.push(format!("--resume={id}"));
    }
    if request.mcp_url.is_some() {
        args.extend([
            "--allowedTools".to_string(),
            GOAT_MCP_TOOL_WILDCARD.to_string(),
        ]);
    }
    args.extend(["--tools", "default"].map(String::from));
    args.extend([
        "--permission-mode".to_string(),
        permission_mode.as_str().to_string(),
    ]);
    if permission_mode == PermissionMode::BypassPermissions {
        args.push("--allow-dangerously-skip-permissions".to_string());
    }
    args.push("--include-partial-messages".to_string());
    if !request.cwd.is_empty() {
        args.extend(["--add-dir".to_string(), request.cwd.to_string()]);
    }
    for dir in add_dirs {
        args.extend(["--add-dir".to_string(), dir]);
    }
    if let SessionIdentity::New(id) = request.identity {
        args.push(format!("--session-id={id}"));
    }
    args.extend(passthrough);
    if !settings.is_empty() {
        args.extend([
            "--settings".to_string(),
            Value::Object(settings).to_string(),
        ]);
    }

    let mut launch = Launch::new(options.binary.clone());
    launch.args = args.into_iter().map(OsString::from).collect();
    if !request.cwd.is_empty() {
        launch.cwd = Some(PathBuf::from(request.cwd));
    }
    launch.nice = options.nice;
    launch.kill_grace = options.kill_grace;
    launch.env_remove = REMOVED_ENV
        .iter()
        .chain(REMOVED_HOST_IDENTITY.iter())
        .map(OsString::from)
        .collect();
    launch.env_remove_prefixes = REMOVED_ENV_PREFIXES.map(String::from).to_vec();
    let mut env: Vec<(String, String)> = vec![
        // v1 ClaudeHome.ts:76, kept verbatim ("goat-rename: legacy").
        ("CLAUDE_CODE_ENTRYPOINT".into(), "t3-code".into()),
    ];
    if matches!(request.identity, SessionIdentity::Resume(_))
        && std::env::var_os("MCP_CONNECTION_NONBLOCKING").is_none()
        && !options
            .env
            .iter()
            .any(|(k, _)| k == "MCP_CONNECTION_NONBLOCKING")
    {
        env.push(("MCP_CONNECTION_NONBLOCKING".into(), "0".into()));
    }
    env.extend(options.env.iter().cloned());
    if let Some(url) = request.mcp_url {
        env.extend(proxy_bypass(url, &options.env));
    }
    launch.env_set = env
        .into_iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
    Ok((launch, folds, permission_mode))
}

fn resolve_path(cwd: &str, path: &str) -> PathBuf {
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(|home| Path::new(&home).join(rest))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    };
    if expanded.is_absolute() {
        expanded
    } else {
        Path::new(if cwd.is_empty() { "." } else { cwd }).join(expanded)
    }
}

/// v1 `claudeMcpProxyBypassEnvironment`: exempt the MCP host from any proxy.
fn proxy_bypass(url: &str, instance_env: &[(String, String)]) -> Vec<(String, String)> {
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or(url)
        .split(['/', '?'])
        .next()
        .unwrap_or_default();
    let host = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default()
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
    };
    let lookup = |key: &str| {
        instance_env
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .or_else(|| std::env::var(key).ok())
    };
    let lower = lookup("no_proxy");
    let existing = lookup("NO_PROXY").or(lower.clone()).unwrap_or_default();
    let mut entries: Vec<String> = existing
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect();
    if host.is_empty() || entries.iter().any(|entry| entry == "*" || entry == host) {
        return Vec::new();
    }
    entries.push(host.to_string());
    let value = entries.join(",");
    let mut out = vec![("NO_PROXY".to_string(), value.clone())];
    if lower.is_some() {
        out.push(("no_proxy".to_string(), value));
    }
    out
}
