//! Status of ACP registry and local ACP agents, lifted from GOAT v1 (goat-si/goat 916b5ccc1b2),
//! `packages/provider-acp-registry/src/server/`:
//! - `probe.ts:144-202,301-368,389-606` (auth methods, commands, the probe session and its result)
//! - `probeHelpers.ts` (`acpRegistryProbeFailure`, `normalizeAcpRegistryWebUrl`)
//! - `driverSnapshots.ts:36-277` (`buildInitialAcpRegistrySnapshot`, `buildCheckedAcpRegistrySnapshot`,
//!   `checkAcpRegistryProviderStatus`)
//! - `snapshotReadiness.ts` (`acpRegistrySnapshotReadiness`)
//! - `deepSeekProbeHistory.ts` (`isolateDeepSeekProbeHistory`)
//! - `modelDiscovery.ts` (`discoverAcpRegistryModelOptions`)
//! - `agentVersion.ts` (`boundedAgentVersion`), `shellDisplayToken.ts`

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use goat2_contracts::{
    ModelSelection, ProviderInstanceId, ProviderOptionDescriptor, ProviderProbeResult,
    ServerProviderAuthStatus, ServerProviderState,
};
use goat2_engine_api::{EngineSession, LaunchSpec, TurnSettings};
use serde_json::{Value, json};

use super::minimax::{MiniMaxCodeQuotaReader, QuotaReading};
use super::models::{
    LiveConfiguration, MAX_ID_LENGTH, MAX_NAME_LENGTH, ProbeModes, current_model_options,
    flatten_select_choices, models_from_discovery, normalize_live_configuration, parse_probe_modes,
    with_learned_model_options,
};
use super::support::{
    CommandResult, auth_status, bounded_opaque_value, bounded_text, command_environments,
    is_missing_probe_tool_result, regex_is, resolve_executable, resolve_provider_probe_timeout,
    safe_process_cwd,
};
use super::{AcpProbeFailure, ProbeConfig, checked_at_now, effective_command, probe_spec};
use crate::engine::{AcpEngineFactory, AcpSession};
use crate::registry::index::{RegistrySettings, Source};
use crate::wire::find_model_config_option;

/// v1 probe.ts:66,70-72; probeHelpers.ts:10.
const MAX_AUTH_METHODS: usize = 32;
const MAX_COMMANDS: usize = 1_024;
const MAX_COMMAND_LINE_LENGTH: usize = 2_048;
const PROBE_TIMEOUT_MS: u64 = 60_000;
const MAX_DESCRIPTION_LENGTH: usize = 1_024;
/// v1 modelDiscovery.ts:13-16.
const MODEL_DISCOVERY_RESTORE_TIMEOUT: Duration = Duration::from_secs(5);
const MODEL_DISCOVERY_BATCH_TIMEOUT: Duration = Duration::from_secs(30);
const MODEL_DISCOVERY_BATCH_SIZE: usize = 24;

/// v1 `AcpRegistryInspection` as GOAT 2 can tell it: the command the flavor resolved, found or not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inspection {
    Ready {
        version: Option<String>,
    },
    Unconfigured,
    NotFound {
        agent_id: String,
    },
    Unsupported {
        agent_id: String,
        version: Option<String>,
    },
    MissingRunner {
        local: bool,
        runner: String,
        version: Option<String>,
    },
    Unprepared {
        agent_id: String,
        version: Option<String>,
    },
    Failed {
        message: String,
    },
}

/// v1 snapshotReadiness.ts: the readiness fields a snapshot shows for an inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Readiness {
    pub installed: bool,
    pub version: Option<String>,
    pub status: ServerProviderState,
    pub message: Option<String>,
}

/// v1 `acpRegistrySnapshotReadiness` (snapshotReadiness.ts:5-60).
pub fn snapshot_readiness(inspection: &Inspection) -> Readiness {
    let r = |installed, version, status, message: Option<String>| Readiness {
        installed,
        version,
        status,
        message,
    };
    match inspection {
        Inspection::Ready { version } => r(true, version.clone(), ServerProviderState::Ready, None),
        Inspection::Unconfigured => r(
            false,
            None,
            ServerProviderState::Warning,
            Some("Select an ACP Registry agent or configure a local ACP executable before starting a thread.".into()),
        ),
        Inspection::NotFound { agent_id } => r(
            false,
            None,
            ServerProviderState::Error,
            Some(format!("ACP Registry does not contain agent '{agent_id}'.")),
        ),
        Inspection::Unsupported { agent_id, version } => r(
            false,
            version.clone(),
            ServerProviderState::Error,
            Some(format!(
                "ACP Registry agent '{agent_id}' has no compatible distribution for this environment."
            )),
        ),
        Inspection::MissingRunner {
            local,
            runner,
            version,
        } => r(
            false,
            version.clone(),
            ServerProviderState::Error,
            Some(if *local {
                "Local ACP executable is not available on this environment's PATH.".into()
            } else {
                format!("ACP executable '{runner}' is not available on this environment's PATH.")
            }),
        ),
        Inspection::Unprepared { agent_id, version } => r(
            false,
            version.clone(),
            ServerProviderState::Warning,
            Some(format!(
                "ACP Registry agent '{agent_id}' has not been prepared on this environment."
            )),
        ),
        Inspection::Failed { message } => r(
            false,
            None,
            ServerProviderState::Error,
            Some(message.clone()),
        ),
    }
}

/// v1 `AcpRegistryProbeAuthMethod`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeAuthMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// ACP `type`: `agent` (default), `env_var` or `terminal`.
    pub kind: String,
    /// The login command a terminal method runs, for display.
    pub command: Option<String>,
    pub env_var_names: Vec<String>,
    pub link: Option<String>,
}

/// v1 `shellDisplayToken`.
pub fn shell_display_token(token: &str) -> String {
    let safe = !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if safe {
        token.to_owned()
    } else {
        format!("'{}'", token.replace('\'', "'\\''"))
    }
}

/// v1 `normalizeAcpRegistryWebUrl` (probeHelpers.ts:18-22).
pub fn normalize_web_url(value: &str) -> Option<String> {
    if value.chars().count() > 2_048 {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    matches!(url.scheme(), "https" | "http").then(|| url.as_str().to_owned())
}

/// v1 `terminalAuthCommand` (probe.ts:149-159).
fn terminal_auth_command(method: &Value, command: &str, args: &[String]) -> Option<String> {
    let mut parts: Vec<String> = method
        .get("env")
        .and_then(Value::as_object)
        .map(|env| {
            env.iter()
                .map(|(name, value)| {
                    format!(
                        "{name}={}",
                        shell_display_token(value.as_str().unwrap_or_default())
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    parts.push(shell_display_token(command));
    parts.extend(args.iter().map(|a| shell_display_token(a)));
    parts.extend(
        method
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(shell_display_token),
    );
    let display = parts.join(" ");
    (display.chars().count() <= MAX_COMMAND_LINE_LENGTH).then_some(display)
}

/// v1 `normalizeAcpRegistryAuthMethods` (probe.ts:161-202), on the raw `initialize` result.
pub fn normalize_auth_methods(
    initialize: Option<&Value>,
    spawn: Option<(&str, &[String])>,
) -> Vec<ProbeAuthMethod> {
    let mut normalized = Vec::new();
    for method in initialize
        .and_then(|init| init.get("authMethods"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = method
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| bounded_opaque_value(id, MAX_ID_LENGTH))
        else {
            continue;
        };
        let kind = method
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("agent")
            .to_owned();
        let env_var_names: Vec<String> = if kind == "env_var" {
            method
                .get("vars")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|var| var.get("name").and_then(Value::as_str))
                .filter_map(|name| bounded_opaque_value(name, MAX_ID_LENGTH))
                .take(16)
                .collect()
        } else {
            Vec::new()
        };
        let command = match spawn {
            Some((command, args)) if kind == "terminal" => {
                terminal_auth_command(method, command, args)
            }
            _ => None,
        };
        let link = if kind == "env_var" {
            method
                .get("link")
                .and_then(Value::as_str)
                .filter(|l| !l.is_empty())
                .and_then(normalize_web_url)
        } else {
            None
        };
        let name = bounded_text(
            method
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            MAX_NAME_LENGTH,
        );
        normalized.push(ProbeAuthMethod {
            name: if name.is_empty() { id.clone() } else { name },
            id,
            description: method
                .get("description")
                .and_then(Value::as_str)
                .map(|d| bounded_text(d, MAX_DESCRIPTION_LENGTH))
                .filter(|d| !d.is_empty()),
            kind,
            command,
            env_var_names,
            link,
        });
        if normalized.len() == MAX_AUTH_METHODS {
            break;
        }
    }
    normalized
}

/// v1 `ServerProviderSlashCommand`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub input_hint: Option<String>,
}

/// v1 `ServerProviderSkill` for a `$name` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSkill {
    pub name: String,
    pub description: Option<String>,
    pub path: String,
}

/// v1 `AcpRegistryAvailableCommands`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AvailableCommands {
    pub slash_commands: Vec<SlashCommand>,
    pub skills: Vec<AgentSkill>,
}

/// JS `encodeURIComponent`.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// v1 `normalizeAcpRegistryCommands` (probe.ts:301-335).
pub fn normalize_registry_commands(commands: &[Value]) -> AvailableCommands {
    let mut seen = HashSet::new();
    let mut out = AvailableCommands::default();
    for command in commands {
        if seen.len() >= MAX_COMMANDS {
            break;
        }
        let Some(name) = command
            .get("name")
            .and_then(Value::as_str)
            .and_then(|n| bounded_opaque_value(n, MAX_ID_LENGTH))
        else {
            continue;
        };
        if !seen.insert(name.to_lowercase()) {
            continue;
        }
        let description = bounded_text(
            command
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            MAX_DESCRIPTION_LENGTH,
        );
        let description = (!description.is_empty()).then_some(description);
        let hint = command
            .get("input")
            .and_then(|input| input.get("hint"))
            .and_then(Value::as_str)
            .map(|h| bounded_text(h, MAX_DESCRIPTION_LENGTH))
            .filter(|h| !h.is_empty());
        if let Some(skill) = name.strip_prefix('$') {
            let Some(skill) = bounded_opaque_value(skill, MAX_ID_LENGTH) else {
                continue;
            };
            out.skills.push(AgentSkill {
                path: format!("acp://skill/{}", encode_uri_component(&skill)),
                name: skill,
                description,
            });
        } else {
            out.slash_commands.push(SlashCommand {
                name,
                description,
                input_hint: hint,
            });
        }
    }
    out
}

/// v1 `boundedAgentVersion` (agentVersion.ts).
pub fn bounded_agent_version(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value
        .chars()
        .any(|c| (c as u32) <= 0x1f || (0x7f..=0x9f).contains(&(c as u32)))
    {
        return None;
    }
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(64).collect())
}

/// v1 `AcpRegistryOperationError.reason` values a probe reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeErrorReason {
    RunnerUnavailable,
    AuthenticationFailed,
    ProbeFailed,
}

/// v1 `AcpRegistryOperationError` from a probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryProbeError {
    pub reason: ProbeErrorReason,
    pub message: String,
    pub auth_methods: Vec<ProbeAuthMethod>,
    /// A sign-in URL the agent sent (v1 `authAction`; GOAT 2's contract has no field for it yet).
    pub auth_url: Option<String>,
}

/// v1 `acpRegistryProbeFailure` (probeHelpers.ts:24-52). GOAT 2's failure carries the stderr tail
/// in its message, so the missing-tool check reads it there.
pub fn classify_probe_failure(
    failure: &AcpProbeFailure,
    auth_methods: Vec<ProbeAuthMethod>,
) -> RegistryProbeError {
    if failure.timed_out {
        return RegistryProbeError {
            reason: ProbeErrorReason::ProbeFailed,
            message: failure.message.clone(),
            auth_methods: Vec::new(),
            auth_url: None,
        };
    }
    if !failure.auth_required
        && is_missing_probe_tool_result(&CommandResult {
            stdout: String::new(),
            stderr: failure.message.clone(),
            code: 1,
        })
    {
        return RegistryProbeError {
            reason: ProbeErrorReason::RunnerUnavailable,
            message: "The ACP agent executable is not installed or not available.".into(),
            auth_methods: Vec::new(),
            auth_url: None,
        };
    }
    let authentication_failed = failure.auth_required
        || regex_is(
            r"(?i)\b(?:authenticat(?:e|ed|es|ing|ion)|credentials?|log(?:[\s-]+)?in)\b",
            &failure.message,
        );
    RegistryProbeError {
        reason: if authentication_failed {
            ProbeErrorReason::AuthenticationFailed
        } else {
            ProbeErrorReason::ProbeFailed
        },
        message: if authentication_failed {
            "The ACP agent could not complete authentication.".into()
        } else {
            "The ACP agent could not create a test session.".into()
        },
        auth_methods,
        auth_url: failure.auth_url.clone().and_then(|u| normalize_web_url(&u)),
    }
}

/// v1 `AcpRegistryProbeResult.sessionManagement` (probe.ts:358-365).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionManagement {
    pub can_list: bool,
    pub can_load: bool,
    pub can_resume: bool,
    pub can_logout: bool,
    pub can_delete: bool,
    pub can_configure_providers: bool,
}

/// v1 `AcpRegistryConfigurationProbeResult`: what one probe session reported.
#[derive(Debug, Clone, PartialEq)]
pub struct RegistryProbe {
    pub agent_version: Option<String>,
    pub auth_methods: Vec<ProbeAuthMethod>,
    pub session_management: SessionManagement,
    pub live: LiveConfiguration,
    pub commands: AvailableCommands,
    /// Per-model options read by model discovery (v1 learned model options, `discovered`).
    pub learned_model_options: BTreeMap<String, Vec<ProviderOptionDescriptor>>,
}

/// Everything a registry status check found; [ProviderProbeResult] is what the contract carries.
#[derive(Debug, Clone, PartialEq)]
pub struct RegistryStatus {
    pub provider: ProviderProbeResult,
    pub inspection: Inspection,
    pub probe: Option<RegistryProbe>,
    pub error: Option<RegistryProbeError>,
    /// MiniMax Code quota, when a reader was given and v1's conditions hold.
    pub usage: Option<QuotaReading>,
}

/// The temporary history directory of a DeepSeek probe, removed when dropped.
#[derive(Debug)]
pub struct ProbeTempDir(PathBuf);

impl ProbeTempDir {
    fn create(prefix: &str) -> std::io::Result<Self> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "{prefix}{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&path)?;
        Ok(Self(path))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ProbeTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// v1 `isolateDeepSeekProbeHistory` (deepSeekProbeHistory.ts:10-49): DeepSeek's `dsh acp` persists
/// `session/new` before any prompt and does not advertise `session/delete`, so its probe writes
/// history into a temporary directory through a `--patch` file. None: not DeepSeek.
pub fn isolate_deepseek_probe_history(
    command_path: &str,
    program: &str,
    args: &[String],
) -> Result<Option<(Vec<String>, ProbeTempDir)>, String> {
    let source = if command_path.is_empty() {
        program
    } else {
        command_path
    };
    let executable = source.rsplit(['/', '\\']).next().unwrap_or_default();
    if !regex_is(r"(?i)^dsh(?:\.cmd|\.exe)?$", executable) {
        return Ok(None);
    }
    let separator = args.iter().position(|a| a == "--");
    let launcher = &args[..separator.unwrap_or(args.len())];
    let uses_acp_profile = launcher.first().map(String::as_str) == Some("acp")
        || launcher.iter().any(|a| a == "--profile=acp")
        || launcher
            .windows(2)
            .any(|pair| pair[0] == "--profile" && pair[1] == "acp");
    if !uses_acp_profile {
        return Ok(None);
    }
    let failed =
        |_| "Could not prepare temporary history for the DeepSeek Harness probe.".to_owned();
    let directory = ProbeTempDir::create("goat-dsh-acp-probe-").map_err(failed)?;
    let patch_path = directory.path().join("probe.json");
    let patch = json!([
        {"id": "session-persistence-jsonl", "config": {"root": directory.path().join("sessions")}},
        {"id": "session-projection-cache", "disabled": true}
    ]);
    std::fs::write(&patch_path, patch.to_string()).map_err(failed)?;
    let mut next: Vec<String> = launcher.to_vec();
    next.push("--patch".into());
    next.push(patch_path.to_string_lossy().into_owned());
    next.extend(args[launcher.len()..].iter().cloned());
    Ok(Some((next, directory)))
}

/// v1 `discoverAcpRegistryModelOptions` (modelDiscovery.ts:33-91): open each requested model once
/// in the probe session to read the options the agent reports only for its current model, then
/// select the original model again.
pub async fn discover_model_options(
    session: &AcpSession,
    original: Option<&str>,
    requested: &[String],
) -> BTreeMap<String, Vec<ProviderOptionDescriptor>> {
    let mut learned = BTreeMap::new();
    let setup = session.session_setup();
    let (Some(model_option), Some(original)) =
        (find_model_config_option(&setup.config_options), original)
    else {
        return learned;
    };
    let offered: HashSet<String> = flatten_select_choices(model_option)
        .into_iter()
        .map(|c| c.value)
        .collect();
    let mut attempted: HashSet<String> = HashSet::from([original.to_owned()]);
    let select = |model: &str| TurnSettings {
        model_selection: ModelSelection {
            instance_id: ProviderInstanceId::new("probe"),
            model: model.to_owned(),
            options: None,
        },
        runtime_mode: goat2_contracts::RuntimeMode::ApprovalRequired,
    };
    loop {
        let batch: Vec<String> = requested
            .iter()
            .filter(|m| !attempted.contains(*m) && offered.contains(*m))
            .take(MODEL_DISCOVERY_BATCH_SIZE)
            .cloned()
            .collect();
        if batch.is_empty() {
            break;
        }
        attempted.extend(batch.iter().cloned());
        let finished = tokio::time::timeout(MODEL_DISCOVERY_BATCH_TIMEOUT, async {
            for model in &batch {
                // A model the agent refuses keeps no options; the rest still count.
                if session.set_config(&select(model)).await.is_err() {
                    continue;
                }
                let setup = session.session_setup();
                let modes = live_modes(&setup);
                let configuration =
                    normalize_live_configuration(&setup.config_options, modes.as_ref(), None, true);
                if configuration.current_model_id.as_deref() == Some(model.as_str())
                    && let Some((id, options)) = current_model_options(&configuration)
                {
                    learned.entry(id).or_insert(options);
                }
            }
        })
        .await;
        // An agent too slow for one batch is left for a later probe.
        if finished.is_err() {
            break;
        }
    }
    // Some agents save the selected model as the user's default: always select the original.
    if attempted.len() > 1 {
        let _ = tokio::time::timeout(
            MODEL_DISCOVERY_RESTORE_TIMEOUT,
            session.set_config(&select(original)),
        )
        .await;
    }
    learned
}

/// The session's modes with descriptions from setup and the current mode it holds now.
fn live_modes(setup: &crate::wire::SessionSetup) -> Option<ProbeModes> {
    let mut modes = parse_probe_modes(&setup.raw)?;
    if let Some(current) = &setup.modes {
        modes.current_mode_id = current.current_mode_id.clone();
    }
    Some(modes)
}

fn present(value: Option<&Value>) -> bool {
    value.is_some_and(|v| !v.is_null())
}

/// v1 `acpRegistryProbeResult` (probe.ts:337-368) for an open probe session.
async fn read_probe_session(
    session: &AcpSession,
    spawn: (&str, &[String]),
    discover: &[String],
) -> RegistryProbe {
    let init = session.initialize_info();
    let setup = session.session_setup();
    let modes = live_modes(&setup);
    // config_option_update replaces the full option set, so an empty notice is authoritative.
    let live = normalize_live_configuration(
        &setup.config_options,
        modes.as_ref(),
        setup.raw.get("models"),
        true,
    );
    let caps = init
        .raw
        .get("agentCapabilities")
        .cloned()
        .unwrap_or(Value::Null);
    let session_caps = caps
        .get("sessionCapabilities")
        .cloned()
        .unwrap_or(Value::Null);
    let commands = normalize_registry_commands(&session.available_commands().unwrap_or_default());
    // Runs in the probe session before it is deleted, outside the setup deadline.
    let learned_model_options = if discover.is_empty() {
        BTreeMap::new()
    } else {
        discover_model_options(session, live.current_model_id.as_deref(), discover).await
    };
    RegistryProbe {
        agent_version: bounded_agent_version(init.agent_version.as_deref()),
        auth_methods: normalize_auth_methods(Some(&init.raw), Some(spawn)),
        session_management: SessionManagement {
            can_list: present(session_caps.get("list")),
            can_load: caps.get("loadSession").and_then(Value::as_bool) == Some(true),
            can_resume: present(session_caps.get("resume")),
            can_logout: present(caps.get("auth").and_then(|a| a.get("logout"))),
            can_delete: present(session_caps.get("delete")),
            can_configure_providers: present(caps.get("providers")),
        },
        live,
        commands,
        learned_model_options,
    }
}

/// v1 `baseSnapshot` (driverSnapshots.ts:36-96), the fields GOAT 2's contract carries.
#[allow(clippy::too_many_arguments)]
fn base_snapshot(
    enabled: bool,
    settings: &RegistrySettings,
    checked_at: String,
    installed: bool,
    version: Option<String>,
    status: ServerProviderState,
    mut auth: goat2_contracts::ServerProviderAuth,
    message: Option<String>,
    probe: Option<&RegistryProbe>,
    binary_path: Option<String>,
) -> ProviderProbeResult {
    auth.can_logout = Some(auth.can_logout.unwrap_or(false));
    let custom = settings.resolved_custom_models();
    let mut models = models_from_discovery(probe.map(|p| &p.live), &custom, &[]);
    if let Some(probe) = probe {
        models = with_learned_model_options(&models, &probe.learned_model_options);
    }
    ProviderProbeResult {
        installed,
        version,
        installed_version: None,
        cli: None,
        binary_path: if installed { binary_path } else { None },
        status: if enabled {
            status
        } else {
            ServerProviderState::Disabled
        },
        auth,
        models,
        checked_at,
        message,
    }
}

/// v1 `buildInitialAcpRegistrySnapshot` (driverSnapshots.ts:122-137).
pub fn initial_registry_snapshot(
    enabled: bool,
    settings: &RegistrySettings,
) -> ProviderProbeResult {
    base_snapshot(
        enabled,
        settings,
        checked_at_now(),
        false,
        None,
        ServerProviderState::Warning,
        auth_status(ServerProviderAuthStatus::Unknown),
        Some(if enabled {
            "Checking ACP Registry agent readiness...".into()
        } else {
            "ACP Registry is disabled in GOAT settings.".into()
        }),
        None,
        None,
    )
}

/// v1 `buildCheckedAcpRegistrySnapshot` (driverSnapshots.ts:139-205).
pub fn checked_registry_snapshot(
    enabled: bool,
    settings: &RegistrySettings,
    checked_at: String,
    inspection: &Inspection,
    probe: Option<&RegistryProbe>,
    error: Option<&RegistryProbeError>,
    binary_path: Option<String>,
) -> ProviderProbeResult {
    let readiness = snapshot_readiness(inspection);
    let local = matches!(settings.source, Source::Local);
    let advertised = error
        .filter(|e| e.reason == ProbeErrorReason::AuthenticationFailed)
        .and_then(|e| {
            e.auth_methods
                .iter()
                .find(|m| m.id == settings.auth_method_id)
                .or_else(|| e.auth_methods.first())
        });
    let authentication_message = advertised.map(|method| {
        if method.kind == "terminal" && method.command.is_some() {
            format!(
                "Sign in in provider settings using \"{}\". The login terminal runs on this environment.",
                method.name
            )
        } else if method.kind == "env_var" && !method.env_var_names.is_empty() {
            format!(
                "Set {} under this instance's environment variables in provider settings. GOAT will detect it on the next provider refresh.",
                method.env_var_names.join(", ")
            )
        } else {
            format!("Sign in in provider settings using \"{}\".", method.name)
        }
    });
    let runner_unavailable = error.is_some_and(|e| e.reason == ProbeErrorReason::RunnerUnavailable);
    let auth = if let Some(probe) = probe {
        // Discovery sessions and an empty auth-method list do not prove sign-in.
        let mut auth = auth_status(ServerProviderAuthStatus::Unknown);
        auth.can_logout = Some(probe.session_management.can_logout);
        auth
    } else if error.is_some_and(|e| e.reason == ProbeErrorReason::AuthenticationFailed) {
        let mut auth = auth_status(ServerProviderAuthStatus::Unauthenticated);
        if let Some(method) = advertised {
            auth.auth_type = Some(method.kind.clone());
            auth.label = Some(method.name.clone());
        }
        auth
    } else {
        auth_status(ServerProviderAuthStatus::Unknown)
    };
    base_snapshot(
        enabled,
        settings,
        checked_at,
        if runner_unavailable {
            false
        } else {
            readiness.installed
        },
        if runner_unavailable {
            None
        } else if local {
            probe
                .and_then(|p| p.agent_version.clone())
                .or(readiness.version.clone())
        } else {
            readiness.version.clone()
        },
        // Failed discovery is a warning: an installed agent may still run real turns.
        if error.is_some() {
            ServerProviderState::Warning
        } else {
            readiness.status
        },
        auth,
        match error {
            Some(error) => Some(authentication_message.unwrap_or_else(|| error.message.clone())),
            None => readiness.message,
        },
        probe,
        binary_path,
    )
}

/// v1 `checkAcpRegistryProviderStatus` (driverSnapshots.ts:207-277) with v1's
/// `probeAcpRegistryConfiguration` (probe.ts:389-606). A `quota_reader` also reads the MiniMax Code
/// quota under v1's conditions (`minimaxCodeUsageEnrichment.ts`).
pub async fn check_registry_provider_status(
    factory: &AcpEngineFactory,
    config: &ProbeConfig,
    quota_reader: Option<&MiniMaxCodeQuotaReader>,
) -> RegistryStatus {
    let settings = config.registry.clone().unwrap_or_default();
    let enabled = config.enabled && settings.enabled;
    let checked_at = checked_at_now();
    if !enabled {
        return RegistryStatus {
            provider: initial_registry_snapshot(false, &settings),
            inspection: Inspection::Unconfigured,
            probe: None,
            error: None,
            usage: None,
        };
    }
    let local = matches!(settings.source, Source::Local);
    let agent_id = match factory.flavor().engine_driver() {
        goat2_contracts::EngineDriver::AcpRegistry { agent_id } => agent_id,
        _ => settings.agent_id.clone(),
    };
    let cwd = config
        .cwd
        .clone()
        .or_else(safe_process_cwd)
        .unwrap_or_else(|| PathBuf::from("."));
    let finish = |inspection: Inspection,
                  probe: Option<RegistryProbe>,
                  error: Option<RegistryProbeError>,
                  binary: Option<String>,
                  usage: Option<QuotaReading>| {
        RegistryStatus {
            provider: checked_registry_snapshot(
                enabled,
                &settings,
                checked_at.clone(),
                &inspection,
                probe.as_ref(),
                error.as_ref(),
                binary,
            ),
            inspection,
            probe,
            error,
            usage,
        }
    };
    let command = match effective_command(factory, config, &cwd) {
        Ok(command) => command,
        Err(error) => {
            return finish(
                Inspection::Failed {
                    message: format!("Could not inspect ACP Registry agent: {error}"),
                },
                None,
                None,
                None,
                None,
            );
        }
    };
    let program = command.program.to_string_lossy().into_owned();
    if (local && program.trim().is_empty()) || (!local && agent_id.trim().is_empty()) {
        return finish(Inspection::Unconfigured, None, None, None, None);
    }
    let (instance_env, child_env) = command_environments(&command);
    let Some(resolved) = resolve_executable(&command.program, Some(&cwd), &child_env) else {
        let runner = Path::new(&program)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(program.clone());
        return finish(
            Inspection::MissingRunner {
                local,
                runner,
                version: if local {
                    None
                } else {
                    config.registry_version.clone()
                },
            },
            None,
            None,
            None,
            None,
        );
    };
    let inspection = Inspection::Ready {
        version: if local {
            None
        } else {
            config.registry_version.clone()
        },
    };
    let binary_path = Some(resolved.to_string_lossy().into_owned());

    // MiniMax Code quota (v1 enrichUsageLimits), independent of the probe session.
    let usage = match quota_reader {
        Some(reader)
            if settings.read_mini_max_code_quota
                && settings.is_minimax_code()
                && super::minimax::has_explicit_quota_profile(
                    config
                        .launch
                        .as_ref()
                        .map(|l| {
                            l.env
                                .iter()
                                .map(|(name, value)| super::minimax::InstanceVariable {
                                    name: name.clone(),
                                    value: value.clone(),
                                    sensitive: false,
                                })
                                .collect::<Vec<_>>()
                        })
                        .as_deref(),
                ) =>
        {
            Some(reader.read(&instance_env, &command.args).await)
        }
        _ => None,
    };

    let mut args = command.args.clone();
    let _history = match isolate_deepseek_probe_history(&settings.command_path, &program, &args) {
        Ok(Some((next, directory))) => {
            args = next;
            Some(directory)
        }
        Ok(None) => None,
        Err(message) => {
            return finish(
                inspection,
                None,
                Some(RegistryProbeError {
                    reason: ProbeErrorReason::ProbeFailed,
                    message,
                    auth_methods: Vec::new(),
                    auth_url: None,
                }),
                binary_path,
                usage,
            );
        }
    };
    let mut env: BTreeMap<String, String> = command.env.iter().cloned().collect();
    super::support::provider_probe_environment(&mut env);
    let spec = probe_spec(
        &cwd,
        Some(LaunchSpec {
            binary: Some(resolved.clone()),
            args: args.clone(),
            env,
        }),
    );
    let timeout = resolve_provider_probe_timeout("acp_registry", PROBE_TIMEOUT_MS, &instance_env);
    let probe_factory = factory.clone().for_probe();
    let opened = probe_factory.open_probe_within(spec, timeout).await;
    match opened {
        Ok(session) => {
            let probe = read_probe_session(
                &session.session,
                (&program, &command.args),
                &config.discover_models,
            )
            .await;
            session.close().await;
            finish(inspection, Some(probe), None, binary_path, usage)
        }
        Err(failure) => {
            let methods = normalize_auth_methods(
                failure.initialize_raw.as_ref(),
                Some((&program, &command.args)),
            );
            let error = classify_probe_failure(&failure, methods);
            finish(inspection, None, Some(error), binary_path, usage)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_messages_match_v1() {
        assert_eq!(
            snapshot_readiness(&Inspection::MissingRunner {
                local: false,
                runner: "npx".into(),
                version: Some("1.0.0".into())
            }),
            Readiness {
                installed: false,
                version: Some("1.0.0".into()),
                status: ServerProviderState::Error,
                message: Some(
                    "ACP executable 'npx' is not available on this environment's PATH.".into()
                )
            }
        );
        assert_eq!(
            snapshot_readiness(&Inspection::MissingRunner {
                local: true,
                runner: "x".into(),
                version: None
            })
            .message
            .as_deref(),
            Some("Local ACP executable is not available on this environment's PATH.")
        );
        assert_eq!(
            snapshot_readiness(&Inspection::Unconfigured).status,
            ServerProviderState::Warning
        );
        assert_eq!(
            snapshot_readiness(&Inspection::NotFound {
                agent_id: "x".into()
            })
            .message
            .as_deref(),
            Some("ACP Registry does not contain agent 'x'.")
        );
    }

    #[test]
    fn auth_methods_keep_env_vars_links_and_terminal_commands() {
        let init = json!({"authMethods": [
            {"id": "key", "name": "API key", "type": "env_var", "vars": [{"name": "MOCK_KEY"}], "link": "https://example.com/keys"},
            {"id": "term", "name": "Terminal login", "type": "terminal", "args": ["login", "--device"], "env": {"MODE": "a b"}},
            {"id": " bad", "name": "bad"},
            {"id": "agent"}
        ]});
        let args = vec!["acp".to_owned()];
        let methods = normalize_auth_methods(Some(&init), Some(("/bin/agent", &args)));
        assert_eq!(methods.len(), 3);
        assert_eq!(methods[0].env_var_names, ["MOCK_KEY"]);
        assert_eq!(methods[0].link.as_deref(), Some("https://example.com/keys"));
        assert_eq!(
            methods[1].command.as_deref(),
            Some("MODE='a b' /bin/agent acp login --device")
        );
        assert_eq!(methods[2].name, "agent");
        assert_eq!(methods[2].kind, "agent");
    }

    #[test]
    fn auth_failures_explain_the_sign_in_method() {
        let failure = AcpProbeFailure {
            message: "authentication required: Authentication required".into(),
            auth_required: true,
            auth_methods: Vec::new(),
            auth_url: None,
            timed_out: false,
            initialize_raw: None,
        };
        let env_method = ProbeAuthMethod {
            id: "key".into(),
            name: "API key".into(),
            description: None,
            kind: "env_var".into(),
            command: None,
            env_var_names: vec!["MOCK_KEY".into()],
            link: None,
        };
        let error = classify_probe_failure(&failure, vec![env_method]);
        assert_eq!(error.reason, ProbeErrorReason::AuthenticationFailed);
        let snapshot = checked_registry_snapshot(
            true,
            &RegistrySettings::default(),
            "t".into(),
            &Inspection::Ready { version: None },
            None,
            Some(&error),
            Some("/bin/agent".into()),
        );
        assert_eq!(snapshot.status, ServerProviderState::Warning);
        assert_eq!(
            snapshot.auth.status,
            ServerProviderAuthStatus::Unauthenticated
        );
        assert_eq!(snapshot.auth.auth_type.as_deref(), Some("env_var"));
        assert_eq!(
            snapshot.message.as_deref(),
            Some(
                "Set MOCK_KEY under this instance's environment variables in provider settings. GOAT will detect it on the next provider refresh."
            )
        );
        // Login words in a failure count as authentication (v1 probeHelpers.ts:40-42).
        let worded = AcpProbeFailure {
            message: "session setup: Please log in first".into(),
            auth_required: false,
            ..failure.clone()
        };
        assert_eq!(
            classify_probe_failure(&worded, Vec::new()).reason,
            ProbeErrorReason::AuthenticationFailed
        );
        let missing = AcpProbeFailure {
            message: "initialize: connection closed\nnpm error code ENOTCACHED".into(),
            auth_required: false,
            ..failure.clone()
        };
        let error = classify_probe_failure(&missing, Vec::new());
        assert_eq!(error.reason, ProbeErrorReason::RunnerUnavailable);
        let snapshot = checked_registry_snapshot(
            true,
            &RegistrySettings::default(),
            "t".into(),
            &Inspection::Ready {
                version: Some("1.0.0".into()),
            },
            None,
            Some(&error),
            Some("/bin/agent".into()),
        );
        assert!(
            !snapshot.installed && snapshot.version.is_none() && snapshot.binary_path.is_none()
        );
        assert_eq!(
            snapshot.message.as_deref(),
            Some("The ACP agent executable is not installed or not available.")
        );
    }

    #[test]
    fn commands_split_skills_and_dedupe() {
        let commands = normalize_registry_commands(&[
            json!({"name": "review", "description": "Review", "input": {"hint": "path"}}),
            json!({"name": "Review", "description": "dup"}),
            json!({"name": "$my skill", "description": ""}),
        ]);
        assert_eq!(commands.slash_commands.len(), 1);
        assert_eq!(
            commands.slash_commands[0].input_hint.as_deref(),
            Some("path")
        );
        assert_eq!(commands.skills[0].path, "acp://skill/my%20skill");
    }

    #[test]
    fn deepseek_probe_history_goes_to_a_temporary_patch() {
        assert!(
            isolate_deepseek_probe_history("", "/bin/claude", &["acp".into()])
                .unwrap()
                .is_none()
        );
        assert!(
            isolate_deepseek_probe_history("", "/bin/dsh", &["chat".into()])
                .unwrap()
                .is_none()
        );
        let (args, dir) = isolate_deepseek_probe_history(
            "",
            "/opt/bin/DSH.exe",
            &["--profile".into(), "acp".into(), "--".into(), "x".into()],
        )
        .unwrap()
        .unwrap();
        assert_eq!(args[..3], ["--profile", "acp", "--patch"]);
        assert_eq!(args[4..], ["--", "x"]);
        let patch: Value =
            serde_json::from_str(&std::fs::read_to_string(&args[3]).unwrap()).unwrap();
        assert_eq!(
            patch[1],
            json!({"id": "session-projection-cache", "disabled": true})
        );
        assert!(
            patch[0]["config"]["root"]
                .as_str()
                .unwrap()
                .ends_with("sessions")
        );
        let path = dir.path().to_path_buf();
        drop(dir);
        assert!(!path.exists());
    }

    #[test]
    fn agent_versions_are_bounded() {
        assert_eq!(
            bounded_agent_version(Some(" 1.2.3 ")).as_deref(),
            Some("1.2.3")
        );
        assert_eq!(bounded_agent_version(Some("1.2\u{7}")), None);
        assert_eq!(bounded_agent_version(Some("  ")), None);
        assert_eq!(shell_display_token("it's"), "'it'\\''s'");
    }
}
