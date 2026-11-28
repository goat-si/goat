//! Shared probe mechanics, lifted from GOAT v1 (goat-si/goat 916b5ccc1b2):
//! - `packages/provider-core/src/server/snapshotProbe.ts` (timeouts :47-61, missing-tool output
//!   :138-158, spawn-and-collect :159-220, version parsing :222-229, custom models :231-265)
//! - `packages/provider-core/src/server/spawnFailure.ts` (spawn failure classification and messages)
//! - `packages/provider-core/src/server/probeEnvironment.ts` (`providerProbeEnvironment`)
//! - `packages/shared/src/cliPath.ts:10-13,58-73` (`withLoginShellPathNote`)
//! - `packages/shared/src/model.ts:32-38,427-474` (`createModelCapabilities`, `readCustomModelEntries`)

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use goat2_contracts::{
    ModelCapabilities, ProviderOptionDescriptor, ServerProviderAuth, ServerProviderAuthStatus,
    ServerProviderModel,
};
use tokio::io::AsyncReadExt;

use crate::registry::command_path;
use crate::registry::settings::CustomModelSetting as CustomModel;

/// v1 snapshotProbe.ts:47.
pub const DEFAULT_TIMEOUT_MS: u64 = 4_000;
/// v1 snapshotProbe.ts:48.
pub const AUTH_PROBE_TIMEOUT_MS: u64 = 10_000;
/// v1 snapshotProbe.ts:159.
pub const MAX_PROBE_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// v1 probeEnvironment.ts:1-13: keep automatic installs out of background provider probes.
pub const PROVIDER_PROBE_ENVIRONMENT: [(&str, &str); 7] = [
    ("MISE_OFFLINE", "1"),
    ("MISE_AUTO_INSTALL", "0"),
    ("MISE_NOT_FOUND_AUTO_INSTALL", "0"),
    ("npm_config_offline", "true"),
    ("NPM_CONFIG_OFFLINE", "true"),
    ("UV_OFFLINE", "1"),
    ("COREPACK_ENABLE_NETWORK", "0"),
];

/// v1 `providerProbeEnvironment`.
pub fn provider_probe_environment(env: &mut BTreeMap<String, String>) {
    for (name, value) in PROVIDER_PROBE_ENVIRONMENT {
        env.insert(name.to_owned(), value.to_owned());
    }
}

/// v1 `resolveProviderProbeTimeoutMs` (snapshotProbe.ts:50-61): `GOAT_<PROVIDER>_PROBE_TIMEOUT_MS`
/// only extends the default, and never past a signed 32-bit millisecond delay.
pub fn resolve_provider_probe_timeout(
    provider: &str,
    default_ms: u64,
    env: &BTreeMap<String, String>,
) -> Duration {
    let key = format!("GOAT_{}_PROBE_TIMEOUT_MS", provider.to_uppercase());
    let parsed = env.get(&key).and_then(|raw| {
        let trimmed = raw.trim();
        // JS Number(): empty text is 0, and only an integral finite value counts.
        let number: f64 = if trimmed.is_empty() {
            0.0
        } else {
            trimmed.parse().ok()?
        };
        (number.is_finite() && number.fract() == 0.0 && number >= 0.0).then_some(number as u64)
    });
    match parsed {
        Some(ms) if ms > default_ms && ms <= 2_147_483_647 => Duration::from_millis(ms),
        _ => Duration::from_millis(default_ms),
    }
}

/// v1 `CommandResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Why a CLI probe command produced no result.
#[derive(Debug)]
pub enum CliError {
    /// The process could not be started.
    Spawn(io::Error),
    /// v1 `ProviderCommandNotFoundError`: an offline mise shim reported the tool missing.
    CommandNotFound,
    /// v1 `ProviderProbeOutputLimitError`.
    OutputLimit(&'static str),
    Io(io::Error),
}

/// v1 `isMissingMiseToolResult` (snapshotProbe.ts:138-147).
pub fn is_missing_mise_tool_result(result: &CommandResult) -> bool {
    let output = format!("{}\n{}", result.stdout, result.stderr);
    result.code != 0
        && regex_is(r"(?i)\bmise\b", &output)
        && regex_is(
            r"(?i)not installed|not found|no versions found|no version is set for shim|is not a mise bin|failed to install",
            &output,
        )
}

/// v1 `isMissingProbeToolResult` (snapshotProbe.ts:149-158).
pub fn is_missing_probe_tool_result(result: &CommandResult) -> bool {
    if is_missing_mise_tool_result(result) {
        return true;
    }
    let output = format!("{}\n{}", result.stdout, result.stderr);
    result.code != 0
        && (regex_is(r"(?i)\bENOTCACHED\b", &output)
            || regex_is(
                r"(?is)\buv\b.*\boffline\b.*(?:not found|not available|no cached)",
                &output,
            )
            || regex_is(
                r"(?is)corepack.*(?:network access is disabled|COREPACK_ENABLE_NETWORK)",
                &output,
            ))
}

pub(crate) fn regex_is(pattern: &str, text: &str) -> bool {
    regex::Regex::new(pattern)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

/// v1 `parseCliVersionResult` (snapshotProbe.ts:161-166).
pub fn parse_cli_version_result(result: &CommandResult) -> Option<String> {
    if result.code != 0 {
        return None;
    }
    parse_generic_cli_version(&format!("{}\n{}", result.stdout, result.stderr))
}

/// v1 `parseGenericCliVersion` (snapshotProbe.ts:222-229). The v1 pattern uses look-around, which
/// the regex crate lacks: the token edges are checked by hand around each greedy match.
pub fn parse_generic_cli_version(output: &str) -> Option<String> {
    let re = regex::Regex::new(
        r"v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)",
    )
    .ok()?;
    let edge = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-');
    let after_edge = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-');
    let mut start = 0;
    while start < output.len() {
        let found = re.captures_at(output, start)?;
        let whole = found.get(0)?;
        let version = found.get(1)?;
        let before = output[..whole.start()].chars().next_back();
        let mut next = output[whole.end()..].chars();
        let following = next.next();
        let dotted_word =
            following == Some('.') && next.next().is_some_and(|c| c.is_ascii_alphanumeric());
        if !before.is_some_and(edge) && !following.is_some_and(after_edge) && !dotted_word {
            return Some(version.as_str().to_owned());
        }
        // Retry from the next character (a later start may satisfy the token edges).
        start = whole.start() + output[whole.start()..].chars().next()?.len_utf8();
    }
    None
}

/// Run a probe command and collect its output (v1 `spawnAndCollect`, snapshotProbe.ts:182-220).
/// `Ok(None)` is a timeout (v1 `Effect.timeoutOption`); the child is killed when it is dropped.
pub async fn spawn_and_collect(
    program: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Option<CommandResult>, CliError> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let run = async {
        let result = collect_command(command).await?;
        if env.get("MISE_OFFLINE").map(String::as_str) == Some("1")
            && is_missing_probe_tool_result(&result)
        {
            return Err(CliError::CommandNotFound);
        }
        Ok(result)
    };
    match tokio::time::timeout(timeout, run).await {
        Err(_) => Ok(None),
        Ok(result) => result.map(Some),
    }
}

/// Kills the probe's process group when dropped before the child was reaped (a timeout drops the
/// collecting future; `kill_on_drop` alone would leave the child's own children running).
struct GroupGuard {
    pgid: Option<u32>,
}

impl GroupGuard {
    fn kill(&self) {
        #[cfg(unix)]
        if let Some(pgid) = self.pgid {
            // SAFETY: plain syscall on the group of a child this guard started and has not reaped.
            unsafe {
                libc::kill(-(pgid as libc::pid_t), libc::SIGKILL);
            }
        }
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Spawn `command` with piped stdout and stderr in its own process group and collect both, at
/// most [MAX_PROBE_OUTPUT_BYTES] each (v1 `spawnAndCollect`, snapshotProbe.ts:182-205, with
/// `collectUint8StreamText` caps and `ProviderProbeOutputLimitError`). The moment either stream
/// passes its cap the group is killed and the child reaped, and the call fails with
/// [CliError::OutputLimit]; nothing past the cap is kept (final review 6 finding B1).
pub async fn collect_command(
    mut command: tokio::process::Command,
) -> Result<CommandResult, CliError> {
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(CliError::Spawn)?;
    let mut guard = GroupGuard { pgid: child.id() };
    let stdout = collect(child.stdout.take());
    let stderr = collect(child.stderr.take());
    tokio::pin!(stdout, stderr);
    let (mut out, mut err, mut status) = (None, None, None);
    let outcome = loop {
        let oversized = match (&out, &err) {
            (Some((_, true)), _) => Some("stdout"),
            (_, Some((_, true))) => Some("stderr"),
            _ => None,
        };
        if let Some(stream) = oversized {
            break Err(CliError::OutputLimit(stream));
        }
        if let (Some(_), Some(_), Some(_)) = (&out, &err, &status) {
            break Ok(());
        }
        let step = tokio::select! {
            read = &mut stdout, if out.is_none() => read.map(|r| out = Some(r)),
            read = &mut stderr, if err.is_none() => read.map(|r| err = Some(r)),
            exit = child.wait(), if status.is_none() => exit.map(|s| status = Some(s)),
        };
        if let Err(error) = step {
            break Err(CliError::Io(error));
        }
    };
    if let Err(error) = outcome {
        // The group may outlive its leader (a child writing on), so it is killed either way.
        guard.kill();
        if status.is_none() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        guard.pgid = None;
        return Err(error);
    }
    guard.pgid = None;
    let ((stdout, _), (stderr, _), status) = (
        out.unwrap_or_default(),
        err.unwrap_or_default(),
        status.expect("reaped"),
    );
    Ok(CommandResult {
        stdout,
        stderr,
        code: status.code().unwrap_or(1),
    })
}

async fn collect<R: tokio::io::AsyncRead + Unpin>(reader: Option<R>) -> io::Result<(String, bool)> {
    let Some(reader) = reader else {
        return Ok((String::new(), false));
    };
    let mut bytes = Vec::new();
    reader
        .take(MAX_PROBE_OUTPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    let truncated = bytes.len() > MAX_PROBE_OUTPUT_BYTES;
    bytes.truncate(MAX_PROBE_OUTPUT_BYTES);
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

/// v1 `SpawnFailure` (spawnFailure.ts:7-12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnFailure {
    Missing,
    CwdInaccessible,
    PermissionDenied,
    ExecFailed,
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ErrCode {
    Enoent,
    Eacces,
    Enotdir,
    Other,
}

fn err_code(error: &io::Error) -> ErrCode {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ENOTDIR) {
        return ErrCode::Enotdir;
    }
    match error.kind() {
        io::ErrorKind::NotFound => ErrCode::Enoent,
        io::ErrorKind::PermissionDenied => ErrCode::Eacces,
        _ => ErrCode::Other,
    }
}

/// v1 `classifySpawnFailure` (spawnFailure.ts:14-90).
pub fn classify_spawn_failure(
    error: &CliError,
    cwd: Option<&Path>,
    binary: &str,
    env: &BTreeMap<String, String>,
) -> SpawnFailure {
    let code = match error {
        CliError::CommandNotFound => return SpawnFailure::Missing,
        CliError::Spawn(error) | CliError::Io(error) => err_code(error),
        CliError::OutputLimit(_) => ErrCode::Other,
    };
    let Some(cwd) = cwd else {
        if code != ErrCode::Other && std::env::current_dir().is_err() {
            return SpawnFailure::CwdInaccessible;
        }
        if code != ErrCode::Enoent {
            return SpawnFailure::Unknown;
        }
        return if executable_exists(binary, None, env) == Some(false) {
            SpawnFailure::Missing
        } else {
            SpawnFailure::Unknown
        };
    };
    if code == ErrCode::Other {
        return SpawnFailure::Unknown;
    }
    match std::fs::metadata(cwd) {
        Ok(meta) if !meta.is_dir() => return SpawnFailure::CwdInaccessible,
        Ok(_) => {
            if !directory_searchable(cwd) {
                return SpawnFailure::CwdInaccessible;
            }
        }
        Err(error) => {
            return if err_code(&error) == ErrCode::Other {
                SpawnFailure::Unknown
            } else {
                SpawnFailure::CwdInaccessible
            };
        }
    }
    match code {
        ErrCode::Enoent => match executable_exists(binary, Some(cwd), env) {
            None => SpawnFailure::Unknown,
            Some(true) => SpawnFailure::ExecFailed,
            Some(false) => SpawnFailure::Missing,
        },
        ErrCode::Eacces => SpawnFailure::PermissionDenied,
        _ => SpawnFailure::Unknown,
    }
}

#[cfg(unix)]
fn directory_searchable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: c_path is a valid NUL-terminated string for the duration of the call.
    unsafe { libc::access(c_path.as_ptr(), libc::X_OK) == 0 }
}

#[cfg(not(unix))]
fn directory_searchable(_path: &Path) -> bool {
    true
}

fn path_separator() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

/// v1 `executableExists` (spawnFailure.ts:92-128): Some(true) found, Some(false) proven absent,
/// None when it cannot tell.
pub fn executable_exists(
    binary: &str,
    cwd: Option<&Path>,
    env: &BTreeMap<String, String>,
) -> Option<bool> {
    let paths: Vec<PathBuf> = if binary.contains('/') || binary.contains('\\') {
        vec![PathBuf::from(binary)]
    } else {
        env.get("PATH")
            .map(String::as_str)
            .unwrap_or("/usr/bin:/bin")
            .split(path_separator())
            .map(|dir| Path::new(if dir.is_empty() { "." } else { dir }).join(binary))
            .collect()
    };
    let extensions: Vec<String> = match env.get("PATHEXT") {
        Some(ext) if Path::new(binary).extension().is_none() => std::iter::once(String::new())
            .chain(ext.split(';').map(str::to_owned))
            .collect(),
        _ => vec![String::new()],
    };
    let mut uncertain = false;
    let found = paths.iter().any(|path| {
        extensions.iter().any(|extension| {
            if cwd.is_none() && !path.is_absolute() {
                return false;
            }
            let base = match cwd {
                Some(cwd) => cwd.join(path),
                None => path.clone(),
            };
            let mut candidate = base.into_os_string();
            candidate.push(extension);
            match std::fs::metadata(&candidate) {
                Ok(meta) => meta.is_file(),
                Err(error) => {
                    if !matches!(err_code(&error), ErrCode::Enoent | ErrCode::Enotdir) {
                        uncertain = true;
                    }
                    false
                }
            }
        })
    });
    if found {
        return Some(true);
    }
    if uncertain || (cwd.is_none() && paths.iter().any(|p| !p.is_absolute())) {
        None
    } else {
        Some(false)
    }
}

/// The executable a child started in `cwd` with `env` runs for `binary` (the host process's own
/// directory when `cwd` is None): a path with a separator is taken from `cwd`, a bare name from
/// the environment's PATH (relative entries also from `cwd`), and only a file the platform can
/// execute counts, with Windows' PATHEXT names (v1 AntigravityInstallationLookup.ts:60-70 checks
/// the execute bit, v1 shell.ts:99-154 via [command_path::resolve_executable]; final review
/// finding 19). GOAT 2: the resolved path goes to `ProviderProbeResult.binaryPath`.
pub fn resolve_executable(
    binary: &Path,
    cwd: Option<&Path>,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let text = binary.to_string_lossy();
    if text.is_empty() {
        return None;
    }
    let platform = if cfg!(windows) {
        "win32"
    } else {
        std::env::consts::OS
    };
    let anchored = |path: &Path| match cwd {
        Some(cwd) if path.is_relative() => cwd.join(path),
        _ => path.to_path_buf(),
    };
    if text.contains('/') || text.contains('\\') {
        let path = anchored(binary);
        return command_path::resolve_executable(&path.to_string_lossy(), platform, env);
    }
    let mut env = env.clone();
    let key = ["PATH", "Path", "path"]
        .into_iter()
        .find(|k| env.contains_key(*k))
        .unwrap_or("PATH");
    let value = env
        .get(key)
        .cloned()
        .unwrap_or_else(|| "/usr/bin:/bin".to_owned());
    let entries: Vec<String> = value
        .split(path_separator())
        .map(|entry| {
            if entry.is_empty() {
                // POSIX: an empty entry is the current directory (command_path anchors it).
                return cwd.map_or_else(String::new, |cwd| cwd.display().to_string());
            }
            anchored(Path::new(entry)).display().to_string()
        })
        .collect();
    env.insert(key.to_owned(), entries.join(&path_separator().to_string()));
    command_path::resolve_executable(&text, platform, &env)
}

/// `path` with a leading home directory (a whole path segment) written as `~`; the longest
/// matching home wins.
pub fn redact_home(path: &str, homes: &[String]) -> String {
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let mut best: Option<&str> = None;
    for home in homes {
        let home = home.trim_end_matches(separators);
        if home.is_empty() || best.is_some_and(|b| b.len() >= home.len()) {
            continue;
        }
        if let Some(rest) = path.strip_prefix(home)
            && (rest.is_empty() || rest.starts_with(separators))
        {
            best = Some(home);
        }
    }
    match best {
        Some(home) => format!("~{}", &path[home.len()..]),
        None => path.to_owned(),
    }
}

/// The home directories a probe's failure messages hide: the host's (`HOME`, `USERPROFILE`) and
/// those of the instance environment the probe runs with.
pub fn probe_homes(env: &BTreeMap<String, String>) -> Vec<String> {
    let mut homes = crate::stderr::home_directories();
    homes.extend(
        ["HOME", "USERPROFILE"]
            .iter()
            .filter_map(|name| env.get(*name).cloned()),
    );
    homes
}

/// v1 `spawnFailureMessage` (spawnFailure.ts:130-144), with the host's home directories hidden
/// (see [spawn_failure_message_with_homes]).
pub fn spawn_failure_message(
    failure: SpawnFailure,
    cwd: Option<&Path>,
    binary: &str,
) -> Option<String> {
    spawn_failure_message_with_homes(failure, cwd, binary, &crate::stderr::home_directories())
}

/// v1 `spawnFailureMessage` (spawnFailure.ts:130-144). v1 prints the working directory and the
/// executable whole; GOAT 2 writes a leading home directory as `~` so probe results never carry
/// the user's home path (final review 6 finding D2).
pub fn spawn_failure_message_with_homes(
    failure: SpawnFailure,
    cwd: Option<&Path>,
    binary: &str,
    homes: &[String],
) -> Option<String> {
    let binary = redact_home(binary, homes);
    match failure {
        SpawnFailure::CwdInaccessible => Some(match cwd {
            None => "The GOAT server process cannot access its working directory.".to_owned(),
            Some(cwd) => format!(
                "The GOAT server process cannot enter the working directory `{}`.",
                redact_home(&cwd.display().to_string(), homes)
            ),
        }),
        SpawnFailure::ExecFailed => Some(format!(
            "The executable `{binary}` exists but could not be started; its interpreter or loader may be missing."
        )),
        SpawnFailure::PermissionDenied => Some(format!(
            "The GOAT server process does not have permission to execute `{binary}`."
        )),
        _ => None,
    }
}

/// v1 cliPath.ts:10.
pub const SHELL_DISCOVERY_PENDING_ENV: &str = "GOAT_DESKTOP_SHELL_DISCOVERY_PENDING";
/// v1 cliPath.ts:12-13.
pub const LOGIN_SHELL_PATH_UNREAD_NOTE: &str = "GOAT may not have your login shell's current PATH yet, so it may have searched only the folders it already knew and the standard install folders. If the CLI is installed somewhere else, set its full path as that provider's Binary path under Settings → Providers.";

/// v1 `withLoginShellPathNote` (cliPath.ts:63-73).
pub fn with_login_shell_path_note(message: &str, env: &BTreeMap<String, String>) -> String {
    let reads_login_shell = cfg!(any(target_os = "macos", target_os = "linux"));
    if reads_login_shell && env.get(SHELL_DISCOVERY_PENDING_ENV).map(String::as_str) == Some("1") {
        format!("{message} {LOGIN_SHELL_PATH_UNREAD_NOTE}")
    } else {
        message.to_owned()
    }
}

/// v1 `safeProcessCwd` (spawnFailure.ts:146-152).
pub fn safe_process_cwd() -> Option<PathBuf> {
    std::env::current_dir().ok()
}

/// v1 `createModelCapabilities` (shared/model.ts:32-38).
pub fn create_model_capabilities(descriptors: Vec<ProviderOptionDescriptor>) -> ModelCapabilities {
    ModelCapabilities {
        option_descriptors: Some(descriptors),
    }
}

/// v1 `EMPTY_CAPABILITIES`: `createModelCapabilities({ optionDescriptors: [] })`.
pub fn empty_capabilities() -> ModelCapabilities {
    create_model_capabilities(Vec::new())
}

/// A built-in model with v1's required fields and nothing optional.
pub fn built_in_model(slug: impl Into<String>, name: impl Into<String>) -> ServerProviderModel {
    ServerProviderModel {
        slug: slug.into(),
        name: name.into(),
        short_name: None,
        sub_provider: None,
        aliases: None,
        badge: None,
        is_custom: false,
        is_default: None,
        is_legacy: None,
        supports_text_generation: None,
        capabilities: None,
    }
}

/// `ServerProviderAuth` with only a status.
pub fn auth_status(status: ServerProviderAuthStatus) -> ServerProviderAuth {
    ServerProviderAuth {
        status,
        auth_type: None,
        label: None,
        email: None,
        can_logout: None,
        subscription_sharing: None,
        profile_id: None,
        workspace_id: None,
        endpoint: None,
        action: None,
    }
}

/// v1 `CustomModelDefinition`.
#[derive(Debug, Clone, PartialEq)]
pub struct CustomModelDefinition {
    pub slug: String,
    pub name: String,
    pub capabilities: Option<ModelCapabilities>,
}

/// v1 `readCustomModelEntries` (shared/model.ts:444-474).
pub fn read_custom_model_entries(models: &[CustomModel]) -> Vec<CustomModelDefinition> {
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for raw in models {
        let (slug, name, capabilities) = match raw {
            CustomModel::Slug(slug) => (slug.as_str(), None, None),
            CustomModel::Entry(entry) => (
                entry.slug.as_str(),
                entry.name.as_deref(),
                entry.capabilities.as_ref(),
            ),
        };
        let slug = slug.trim();
        if slug.is_empty() || !seen.insert(slug.to_owned()) {
            continue;
        }
        let name = name
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(slug)
            .to_owned();
        let capabilities = capabilities
            .and_then(|value| serde_json::to_value(value).ok())
            .filter(|value| !value.is_null())
            .and_then(|value| serde_json::from_value::<ModelCapabilities>(value).ok())
            .map(|caps| create_model_capabilities(caps.option_descriptors.unwrap_or_default()));
        entries.push(CustomModelDefinition {
            slug: slug.to_owned(),
            name,
            capabilities,
        });
    }
    entries
}

/// v1 `providerModelsFromSettings` (snapshotProbe.ts:231-265).
pub fn provider_models_from_settings(
    built_in: Vec<ServerProviderModel>,
    custom_models: &[CustomModel],
    custom_model_capabilities: Option<ModelCapabilities>,
) -> Vec<ServerProviderModel> {
    let entries = read_custom_model_entries(custom_models);
    if entries.is_empty() {
        return built_in;
    }
    let overrides: BTreeMap<&str, &str> = entries
        .iter()
        .filter(|entry| entry.name != entry.slug)
        .map(|entry| (entry.slug.as_str(), entry.name.as_str()))
        .collect();
    let mut models: Vec<ServerProviderModel> = built_in
        .into_iter()
        .map(|mut model| {
            if let Some(name) = overrides.get(model.slug.as_str()) {
                model.short_name = None;
                model.name = (*name).to_owned();
            }
            model
        })
        .collect();
    let mut seen: std::collections::HashSet<String> =
        models.iter().map(|model| model.slug.clone()).collect();
    for entry in entries {
        if !seen.insert(entry.slug.clone()) {
            continue;
        }
        let mut model = built_in_model(entry.slug, entry.name);
        model.is_custom = true;
        model.capabilities = entry
            .capabilities
            .or_else(|| custom_model_capabilities.clone());
        models.push(model);
    }
    models
}

fn host_environment() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// The environment a probe reads settings from: the host's own environment with the instance's
/// launch variables on top (v1 passes the instance environment to every status check).
pub fn instance_environment<'a>(
    layers: impl IntoIterator<Item = &'a [(String, String)]>,
) -> BTreeMap<String, String> {
    let mut env = host_environment();
    for layer in layers {
        for (name, value) in layer {
            env.insert(name.clone(), value.clone());
        }
    }
    env
}

/// Host identity a provider child must not inherit (as
/// [crate::process::Launch::without_host_identity]).
pub fn is_host_identity(name: &str) -> bool {
    name.starts_with("GOAT_")
        || name.starts_with("T3CODE_")
        || matches!(
            name,
            "CODEX_THREAD_ID"
                | "CODEX_SESSION_ID"
                | "CODEX_TOOL_CALL_ID"
                | "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
        )
}

/// The environment a probe child gets: the host's environment without GOAT's own identity, the
/// explicit layers on top, then v1's `providerProbeEnvironment`.
pub fn child_environment<'a>(
    layers: impl IntoIterator<Item = &'a [(String, String)]>,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = host_environment()
        .into_iter()
        .filter(|(k, _)| !is_host_identity(k))
        .collect();
    for layer in layers {
        for (name, value) in layer {
            env.insert(name.clone(), value.clone());
        }
    }
    provider_probe_environment(&mut env);
    env
}

/// [instance_environment] and [child_environment] for a launch command. A command that replaces
/// the whole inherited environment ([crate::process::REMOVE_INHERITED], registry agents) starts
/// from its own variables, as its agent does (final review finding 3).
pub fn command_environments(
    command: &crate::flavor::LaunchCommand,
) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    if command
        .env_remove
        .iter()
        .any(|name| name == crate::process::REMOVE_INHERITED)
    {
        let own: BTreeMap<String, String> = command.env.iter().cloned().collect();
        let mut child = own.clone();
        provider_probe_environment(&mut child);
        return (own, child);
    }
    (
        instance_environment([command.env.as_slice()]),
        child_environment([command.env.as_slice()]),
    )
}

/// v1 probeHelpers.ts:12-13.
pub fn bounded_text(value: &str, maximum: usize) -> String {
    value.trim().chars().take(maximum).collect()
}

/// v1 probeHelpers.ts:15-16 (v1 counts UTF-16 units; GOAT 2 counts chars).
pub fn bounded_opaque_value(value: &str, maximum: usize) -> Option<String> {
    (!value.is_empty() && value == value.trim() && value.chars().count() <= maximum)
        .then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_override_only_extends() {
        let mut env = BTreeMap::new();
        let resolve = |env: &BTreeMap<String, String>| {
            resolve_provider_probe_timeout("acp_registry", 60_000, env)
        };
        assert_eq!(resolve(&env), Duration::from_secs(60));
        for (raw, expected) in [
            ("1000", 60),
            ("90000", 90),
            ("90000.5", 60),
            ("3000000000", 60),
            ("nope", 60),
        ] {
            env.insert("GOAT_ACP_REGISTRY_PROBE_TIMEOUT_MS".into(), raw.into());
            assert_eq!(resolve(&env), Duration::from_secs(expected), "{raw}");
        }
    }

    #[test]
    fn generic_version_matches_v1_token_edges() {
        let parse = |s: &str| parse_generic_cli_version(s);
        assert_eq!(parse("grok 1.0.52\n").as_deref(), Some("1.0.52"));
        assert_eq!(
            parse("v2.3.4-beta.1+build.5").as_deref(),
            Some("2.3.4-beta.1+build.5")
        );
        assert_eq!(parse("fx version v0.0.13 (abc)").as_deref(), Some("0.0.13"));
        assert_eq!(parse("node_1.2.3"), None);
        assert_eq!(parse("1.2.3.4"), None);
        assert_eq!(parse("x1.2.3 then 4.5.6").as_deref(), Some("4.5.6"));
        assert_eq!(parse("no version"), None);
    }

    #[test]
    fn missing_probe_tools_follow_v1_patterns() {
        let result = |stderr: &str, code| CommandResult {
            stdout: String::new(),
            stderr: stderr.into(),
            code,
        };
        assert!(is_missing_probe_tool_result(&result(
            "npm error code ENOTCACHED",
            1
        )));
        assert!(!is_missing_probe_tool_result(&result(
            "npm error code ENOTCACHED",
            0
        )));
        assert!(is_missing_probe_tool_result(&result(
            "mise ERROR tool node@22 is not installed",
            1
        )));
        assert!(is_missing_probe_tool_result(&result(
            "error: uv is offline\nand package not found",
            2
        )));
        assert!(is_missing_probe_tool_result(&result(
            "Corepack: network access is disabled",
            1
        )));
        assert!(!is_missing_probe_tool_result(&result("boom", 1)));
    }

    #[test]
    fn spawn_failures_classify_missing_and_existing_executables() {
        let dir = std::env::temp_dir();
        let env = BTreeMap::from([("PATH".to_owned(), "/goat2-test-no-such-dir".to_owned())]);
        let missing = CliError::Spawn(io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(
            classify_spawn_failure(&missing, Some(&dir), "goat2-no-such-cli", &env),
            SpawnFailure::Missing
        );
        let existing = std::env::current_exe().unwrap();
        assert_eq!(
            classify_spawn_failure(&missing, Some(&dir), existing.to_str().unwrap(), &env),
            SpawnFailure::ExecFailed
        );
        let denied = CliError::Spawn(io::Error::from(io::ErrorKind::PermissionDenied));
        assert_eq!(
            classify_spawn_failure(&denied, Some(&dir), "x", &env),
            SpawnFailure::PermissionDenied
        );
        assert_eq!(
            classify_spawn_failure(&CliError::CommandNotFound, Some(&dir), "x", &env),
            SpawnFailure::Missing
        );
        assert_eq!(
            classify_spawn_failure(
                &missing,
                Some(Path::new("/goat2-test-nonexistent-cwd")),
                "x",
                &env
            ),
            SpawnFailure::CwdInaccessible
        );
        assert_eq!(
            spawn_failure_message(SpawnFailure::PermissionDenied, Some(&dir), "fx").as_deref(),
            Some("The GOAT server process does not have permission to execute `fx`.")
        );
    }

    /// Final review 6 finding D2 (v1 spawnFailure.ts:130-144 prints the paths whole): a working
    /// directory or executable under the home directory is shown from `~`, so probe results never
    /// carry the user's home path.
    #[test]
    fn failure_messages_show_home_paths_from_tilde() {
        let Some(home) = std::env::var("HOME").ok().filter(|h| h.len() > 1) else {
            return;
        };
        let cwd = Path::new(&home).join("goat2-test-no-such-dir");
        let message =
            spawn_failure_message(SpawnFailure::CwdInaccessible, Some(&cwd), "fx").unwrap();
        assert_eq!(
            message,
            "The GOAT server process cannot enter the working directory `~/goat2-test-no-such-dir`."
        );
        let binary = format!("{home}/bin/grok");
        for failure in [SpawnFailure::PermissionDenied, SpawnFailure::ExecFailed] {
            let message = spawn_failure_message(failure, None, &binary).unwrap();
            assert!(!message.contains(&home), "{message}");
            assert!(message.contains("`~/bin/grok`"), "{message}");
        }
        // Only a whole leading path segment is the home directory.
        let sibling = format!("{home}-other/grok");
        let message =
            spawn_failure_message(SpawnFailure::PermissionDenied, None, &sibling).unwrap();
        assert!(message.contains(&sibling), "{message}");
    }

    #[test]
    fn custom_models_append_and_rename() {
        use crate::registry::settings::CustomModelEntry;
        let models = provider_models_from_settings(
            vec![built_in_model("a", "A")],
            &[
                CustomModel::Slug(" a ".into()),
                CustomModel::Slug("b".into()),
            ],
            Some(empty_capabilities()),
        );
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "A");
        assert!(models[1].is_custom && models[1].slug == "b");
        assert_eq!(models[1].capabilities, Some(empty_capabilities()));
        let renamed = provider_models_from_settings(
            vec![built_in_model("a", "A")],
            &[CustomModel::Entry(CustomModelEntry {
                slug: "a".into(),
                name: Some("Renamed".into()),
                capabilities: None,
            })],
            None,
        );
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].name, "Renamed");
    }
}
