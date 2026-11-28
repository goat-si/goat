//! Managed installs of registry agents, from v1 `AcpRegistrySupport.ts` at 916b5ccc1b2: the command
//! runner (`:717-800`), package install receipts (`:169-180,802-881`), npm and uv discovery and
//! install (`:883-1151`), the install lock (`:1153-1178`), install-root checks (`:1180-1207`),
//! binary download and extraction (`:1209-1444`), managed binary directories (`:229-318`) and
//! uninstall (`:1867-1957`). Messages and limits are v1's.
//!
//! Everything lives under caller-supplied directories: `cache_dir` (v1 `providerStatusCacheDir`,
//! holding `acp-registry/`) and `tools_dir` (v1 `<baseDir>/tools`). Nothing here knows `~/.goat2`.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::archive::{self, ArchiveKind};
use super::command_path::{self, Environment};
use super::contracts::{
    AcpRegistryDistribution, AcpRegistryOperationError, AcpRegistryOperationErrorReason as Reason,
};
use super::index::{Agent, BinaryTarget, valid_https_url};
use super::package::{
    decode_npm_manifest, npm_command_name, package_manager_for, parse_npx_package_spec,
    parse_uvx_package_spec,
};
use super::{package_command_candidates, platform_candidates, platform_target};

/// v1 `AcpRegistrySupport.ts:74-88`.
pub const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;
/// Install errors become the provider status message; npm and uv print the actionable error last.
pub const MAX_COMMAND_ERROR_TAIL_CHARS: usize = 1_000;
pub const MAX_PACKAGE_MANIFEST_BYTES: u64 = 1024 * 1024;
pub const ARCHIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(20 * 60);
pub const PACKAGE_INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
pub const PACKAGE_QUERY_TIMEOUT: Duration = Duration::from_secs(30);
/// v1 `AcpRegistrySupport.ts:468-471`.
pub const INSTALL_LOCK_RETRY_COUNT: usize = 300;
pub const INSTALL_LOCK_RETRY_DELAY: Duration = Duration::from_millis(100);
pub const INSTALL_LOCK_STALE: Duration = Duration::from_secs(5 * 60);
pub const PREPARED_BINARY_RESERVATION: Duration = Duration::from_secs(30);

/// v1 `AcpRegistrySupport.ts:209-217` `AcpRegistryError`: a reason and the user-facing detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryError {
    pub reason: Reason,
    pub detail: String,
}

impl RegistryError {
    pub fn new(reason: Reason, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }
    /// v1 `AcpRegistrySupport.ts:219-225`.
    pub fn to_operation_error(&self) -> AcpRegistryOperationError {
        AcpRegistryOperationError {
            reason: self.reason,
            message: self.detail.clone(),
            auth_methods: None,
            auth_action: None,
        }
    }
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for RegistryError {}

/// A registry error, or an unexpected failure the caller names (v1's
/// `isAcpRegistryError(cause) ? cause : new AcpRegistryError(...)` pattern).
#[derive(Debug)]
pub(crate) enum Fault {
    Registry(RegistryError),
    Other,
}
impl From<RegistryError> for Fault {
    fn from(e: RegistryError) -> Self {
        Self::Registry(e)
    }
}
impl From<io::Error> for Fault {
    fn from(_: io::Error) -> Self {
        Self::Other
    }
}
pub(crate) trait OrRegistry<T> {
    fn or_registry(self, reason: Reason, detail: impl Into<String>) -> Result<T, RegistryError>;
}
impl<T> OrRegistry<T> for Result<T, Fault> {
    fn or_registry(self, reason: Reason, detail: impl Into<String>) -> Result<T, RegistryError> {
        self.map_err(|f| match f {
            Fault::Registry(e) => e,
            Fault::Other => RegistryError::new(reason, detail),
        })
    }
}

/// Archive bytes, streamed.
pub type ByteStream = BoxStream<'static, Result<Vec<u8>, String>>;

/// Opens an archive download (v1 uses the host `HttpClient`).
#[async_trait]
pub trait ArchiveDownload: Send + Sync {
    async fn open(&self, url: &str) -> Result<ByteStream, String>;
}

/// HTTPS downloads; redirects must stay on HTTPS without credentials.
pub struct HttpsDownload {
    client: reqwest::Client,
}

impl HttpsDownload {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::custom(|a| {
                    if valid_https_url(a.url().as_str()) && a.previous().len() < 10 {
                        a.follow()
                    } else {
                        a.stop()
                    }
                }))
                .build()
                .map_err(|e| e.to_string())?,
        })
    }
}

/// GET `url` and stream the body; any final status other than 2xx fails, including a redirect
/// the client's policy stopped (v1 `filterStatusOk`, AcpRegistrySupport.ts:1313-1315).
pub(crate) async fn http_stream(client: &reqwest::Client, url: &str) -> Result<ByteStream, String> {
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP status {status} for {}", response.url()));
    }
    Ok(response
        .bytes_stream()
        .map(|chunk| chunk.map(|b| b.to_vec()).map_err(|e| e.to_string()))
        .boxed())
}

#[async_trait]
impl ArchiveDownload for HttpsDownload {
    async fn open(&self, url: &str) -> Result<ByteStream, String> {
        if !valid_https_url(url) {
            return Err("ACP Registry URLs must use HTTPS without embedded credentials.".into());
        }
        http_stream(&self.client, url).await
    }
}

/// JavaScript `encodeURIComponent` (versions become directory names).
pub fn encode_uri_component(value: &str) -> String {
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

/// Version directories sort like `localeCompare(.., {numeric: true})`: digit runs by value.
fn numeric_compare(left: &str, right: &str) -> std::cmp::Ordering {
    fn chunks(s: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in s.chars() {
            let digit = c.is_ascii_digit();
            match out.last_mut() {
                Some((d, run)) if *d == digit => run.push(c),
                _ => out.push((digit, c.to_string())),
            }
        }
        out
    }
    let (a, b) = (chunks(left), chunks(right));
    for (x, y) in a.iter().zip(&b) {
        let order = if x.0 && y.0 {
            let (xs, ys) = (x.1.trim_start_matches('0'), y.1.trim_start_matches('0'));
            xs.len().cmp(&ys.len()).then_with(|| xs.cmp(ys))
        } else {
            x.1.to_lowercase().cmp(&y.1.to_lowercase())
        };
        if order.is_ne() {
            return order;
        }
    }
    a.len().cmp(&b.len()).then_with(|| left.cmp(right))
}

/// Options for [run_command] (v1 `runCommand` options).
pub(crate) struct RunOptions<'a> {
    pub env: Option<&'a Environment>,
    pub timeout: Option<Duration>,
    pub truncated_reason: Reason,
    pub max_stdout: usize,
    /// How messages name the command (`npm`, `uv`); None names it by its path with the home
    /// directory written as `~`.
    pub label: Option<&'a str>,
}
impl Default for RunOptions<'_> {
    fn default() -> Self {
        Self {
            env: None,
            timeout: None,
            truncated_reason: Reason::ArchiveInvalid,
            max_stdout: MAX_COMMAND_OUTPUT_BYTES,
            label: None,
        }
    }
}

/// The home directories install messages hide: the host's and the install environment's.
fn install_homes(env: Option<&Environment>) -> Vec<String> {
    match env {
        Some(env) => crate::probe::support::probe_homes(env),
        None => crate::stderr::home_directories(),
    }
}

/// v1 `AcpRegistrySupport.ts:717-800`: run a package-manager command without a shell, keep at
/// most `max_stdout` bytes of stdout and the last 1000 characters of stderr. The child is killed
/// when the timeout drops it. (Windows `.cmd` managers run through `cmd.exe` with Rust's own
/// argument escaping, where v1 builds the escaped line itself, `shell.ts:774-845`.)
///
/// v1 names the command by its path and keeps the raw stderr tail (`:760-790`). GOAT 2 names it by
/// [RunOptions::label] (else its path from `~`) and cleans stderr line by line before keeping it
/// (home directories become `~`, tokens and sign-in links are replaced, as for agent stderr,
/// [crate::stderr::sanitize_stderr_excerpt]); final review 6 finding C2.
pub(crate) async fn run_command(
    command: &str,
    args: &[String],
    options: RunOptions<'_>,
) -> Result<String, RegistryError> {
    let homes = install_homes(options.env);
    let shown = match options.label {
        Some(label) => label.to_owned(),
        None => crate::probe::support::redact_home(command, &homes),
    };
    let could_not_run = || {
        RegistryError::new(
            Reason::InstallFailed,
            format!("Could not run ACP Registry install command '{shown}'."),
        )
    };
    let run = async {
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(env) = options.env {
            cmd.env_clear().envs(env);
        }
        let mut child = cmd.spawn().map_err(|_| could_not_run())?;
        let mut stdout = child.stdout.take().ok_or_else(could_not_run)?;
        let mut stderr = child.stderr.take().ok_or_else(could_not_run)?;
        let max = options.max_stdout;
        let (out, err, status) = tokio::join!(
            read_capped(&mut stdout, max),
            read_clean_tail(&mut stderr, &homes),
            child.wait()
        );
        let (out, truncated) = out.map_err(|_| could_not_run())?;
        let err = err.map_err(|_| could_not_run())?;
        let status = status.map_err(|_| could_not_run())?;
        let code = status.code().unwrap_or_else(|| {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                128 + status.signal().unwrap_or(0)
            }
            #[cfg(not(unix))]
            {
                1
            }
        });
        if code != 0 {
            return Err(RegistryError::new(
                Reason::InstallFailed,
                format!(
                    "ACP Registry install command '{shown}' exited with code {code}: {}",
                    err.trim()
                ),
            ));
        }
        // Truncated listings would bypass archive traversal validation.
        if truncated {
            return Err(RegistryError::new(
                options.truncated_reason,
                format!(
                    "ACP Registry install command '{shown}' produced more output than expected."
                ),
            ));
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    };
    match options.timeout {
        None => run.await,
        Some(limit) => tokio::time::timeout(limit, run).await.unwrap_or_else(|_| {
            Err(RegistryError::new(
                Reason::InstallFailed,
                format!("Timed out running ACP Registry install command '{shown}'."),
            ))
        }),
    }
}

/// Read `reader` to its end, keeping at most `max` bytes; true when more arrived. A read error
/// fails the command (v1 AcpRegistrySupport.ts:742-758 fails when a stream fails).
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> io::Result<(Vec<u8>, bool)> {
    let mut kept = Vec::new();
    let mut truncated = false;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let room = max.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
        truncated |= n > room;
    }
    Ok((kept, truncated))
}

/// [read_clean_tail] with the host's home directories.
#[cfg(test)]
async fn read_tail<R: tokio::io::AsyncRead + Unpin>(reader: &mut R) -> io::Result<String> {
    read_clean_tail(reader, &crate::stderr::home_directories()).await
}

/// Read `reader` to its end, keeping the last [MAX_COMMAND_ERROR_TAIL_CHARS] characters. Each line
/// is cleaned before it is kept ([crate::stderr::StderrTail]: `homes` become `~`, credentials and
/// sign-in links are replaced), so the cut to the tail can never split a secret. A read error
/// fails the command, as for stdout.
async fn read_clean_tail<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    homes: &[String],
) -> io::Result<String> {
    let mut tail = crate::stderr::StderrTail::new(homes.to_vec());
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        tail.push(&buf[..n]);
    }
    let text = tail.text();
    let count = text.chars().count();
    Ok(text
        .chars()
        .skip(count.saturating_sub(MAX_COMMAND_ERROR_TAIL_CHARS))
        .collect())
}

/// The package kind of a receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageKind {
    Npx,
    Uvx,
}
impl PackageKind {
    pub fn from_distribution(kind: AcpRegistryDistribution) -> Option<Self> {
        match kind {
            AcpRegistryDistribution::Npx => Some(Self::Npx),
            AcpRegistryDistribution::Uvx => Some(Self::Uvx),
            AcpRegistryDistribution::Binary => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Npx => "npx",
            Self::Uvx => "uvx",
        }
    }
    fn distribution(self) -> AcpRegistryDistribution {
        match self {
            Self::Npx => AcpRegistryDistribution::Npx,
            Self::Uvx => AcpRegistryDistribution::Uvx,
        }
    }
}

/// v1 `AcpRegistrySupport.ts:169-180`: where a package install put its command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInstallReceipt {
    pub agent_id: String,
    pub agent_version: String,
    pub distribution: PackageKind,
    pub package_spec: String,
    pub manager_path: String,
    pub bin_directory: String,
    pub executable_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_version: Option<String>,
}

/// v1 `AcpRegistrySupport.ts:90-99` `BoundedAgentId` / `BoundedVersion`.
pub(crate) fn bounded_agent_id(id: &str) -> bool {
    id.encode_utf16().count() <= 128
        && regex::Regex::new(r"^[a-z0-9][a-z0-9._-]*$")
            .expect("static regex")
            .is_match(id)
}
fn bounded_version(version: &mut String) -> bool {
    super::schema::trim_in_place(version);
    version.encode_utf16().count() <= 128
        && regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._+\-]*$")
            .expect("static regex")
            .is_match(version)
}

fn decode_receipt(text: &str) -> Option<PackageInstallReceipt> {
    let mut receipt: PackageInstallReceipt = serde_json::from_str(text).ok()?;
    (bounded_agent_id(&receipt.agent_id) && bounded_version(&mut receipt.agent_version))
        .then_some(receipt)
}

fn exists(path: &Path) -> bool {
    path.try_exists().unwrap_or(false)
}

fn same_string_path(text: &str, path: &Path) -> bool {
    Path::new(text) == path
}

fn parent_is(executable: &str, directory: &str) -> bool {
    Path::new(executable).parent() == Some(Path::new(directory))
}

/// Removes a scoped temp directory (v1 `makeTempDirectoryScoped`).
struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Removes an install lock (v1 `Effect.ensuring(fileSystem.remove(lockPath))`).
struct LockGuard(PathBuf);
impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Paths of one binary install (v1 `binaryPaths`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryPaths {
    pub command_segments: Vec<String>,
    pub install_root: PathBuf,
    pub platform_target: &'static str,
    pub executable_path: PathBuf,
}

/// The install half of v1's catalog: directories, platform and transports.
pub struct Installer {
    pub cache_dir: PathBuf,
    pub tools_dir: PathBuf,
    pub platform: String,
    pub architecture: String,
    pub host_environment: Environment,
    pub(crate) download: Arc<dyn ArchiveDownload>,
}

impl Installer {
    pub fn platform_target(&self) -> Option<&'static str> {
        platform_target(&self.platform, &self.architecture)
    }
    pub(crate) fn registry_directory(&self) -> PathBuf {
        self.cache_dir.join("acp-registry")
    }
    fn package_receipts_directory(&self) -> PathBuf {
        self.registry_directory().join("package-installs")
    }
    /// v1 `AcpRegistrySupport.ts:513-514`.
    pub fn agent_install_root(&self, agent: &Agent) -> PathBuf {
        self.tools_dir
            .join(&agent.id)
            .join(encode_uri_component(&agent.version))
    }
    /// v1 `AcpRegistrySupport.ts:515-516`.
    pub fn package_install_root(&self, agent: &Agent, kind: PackageKind) -> PathBuf {
        self.agent_install_root(agent).join(match kind {
            PackageKind::Npx => "npm",
            PackageKind::Uvx => "python",
        })
    }
    /// v1 `AcpRegistrySupport.ts:517-520`: Windows npm links commands into the prefix itself.
    pub fn package_bin_directory(&self, agent: &Agent, kind: PackageKind) -> PathBuf {
        let root = self.package_install_root(agent, kind);
        if kind == PackageKind::Npx && self.platform == "win32" {
            root
        } else {
            root.join("bin")
        }
    }

    pub(crate) fn resolve_executable(&self, command: &str, env: &Environment) -> Option<PathBuf> {
        command_path::resolve_executable(command, &self.platform, env)
    }

    /// v1 `AcpRegistrySupport.ts:802-807`.
    fn package_receipt_path(&self, agent_id: &str, kind: PackageKind, manager: &str) -> PathBuf {
        let digest: String = Sha256::digest(format!("{}\0{manager}", kind.as_str()).as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        self.package_receipts_directory()
            .join(format!("{agent_id}-{}.json", &digest[..16]))
    }

    /// v1 `AcpRegistrySupport.ts:809-856`: a receipt that still matches this agent, spec, manager
    /// and the files on disk.
    pub async fn read_package_receipt(
        &self,
        agent: &Agent,
        kind: PackageKind,
        package_spec: &str,
        manager: &str,
    ) -> Option<PackageInstallReceipt> {
        let path = self.package_receipt_path(&agent.id, kind, manager);
        let receipt = decode_receipt(&tokio::fs::read_to_string(path).await.ok()?)?;
        if receipt.agent_id != agent.id
            || receipt.agent_version != agent.version
            || receipt.distribution != kind
            || receipt.package_spec != package_spec
            || receipt.manager_path != manager
            || !same_string_path(
                &receipt.bin_directory,
                &self.package_bin_directory(agent, kind),
            )
            || !parent_is(&receipt.executable_path, &receipt.bin_directory)
            || !exists(Path::new(&receipt.executable_path))
        {
            return None;
        }
        if kind == PackageKind::Npx {
            let identity = parse_npx_package_spec(package_spec);
            let root = receipt.package_root.as_deref()?;
            let version = receipt.package_version.as_deref()?;
            let text = tokio::fs::read_to_string(Path::new(root).join("package.json"))
                .await
                .ok()?;
            let manifest = decode_npm_manifest(&text)?;
            if manifest.name != identity.name
                || manifest.version != identity.version
                || version != identity.version
            {
                return None;
            }
        }
        Some(receipt)
    }

    /// v1 `AcpRegistrySupport.ts:858-881`.
    async fn write_package_receipt(
        &self,
        receipt: &PackageInstallReceipt,
    ) -> Result<(), RegistryError> {
        let path = self.package_receipt_path(
            &receipt.agent_id,
            receipt.distribution,
            &receipt.manager_path,
        );
        let write = || -> io::Result<()> {
            let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
            std::fs::create_dir_all(self.package_receipts_directory())?;
            let _ = std::fs::remove_file(&temporary);
            let text = serde_json::to_string(receipt).map_err(io::Error::other)?;
            std::fs::write(&temporary, format!("{text}\n"))?;
            let _ = std::fs::remove_file(&path);
            std::fs::rename(&temporary, &path)
        };
        write().map_err(|_| {
            RegistryError::new(
                Reason::InstallFailed,
                "Could not record the globally installed ACP Registry command.",
            )
        })
    }

    /// v1 `AcpRegistrySupport.ts:883-897`.
    fn parse_package_manager_path(manager: &str, output: &str) -> Result<PathBuf, RegistryError> {
        let lines: Vec<&str> = output
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l).trim())
            .filter(|l| !l.is_empty())
            .collect();
        match lines.as_slice() {
            [line] if Path::new(line).is_absolute() => Ok(PathBuf::from(line)),
            _ => Err(RegistryError::new(
                Reason::InstallFailed,
                format!(
                    "ACP Registry package manager '{manager}' returned an invalid global path."
                ),
            )),
        }
    }

    fn query_options<'a>(env: &'a Environment, label: &'a str) -> RunOptions<'a> {
        RunOptions {
            env: Some(env),
            timeout: Some(PACKAGE_QUERY_TIMEOUT),
            truncated_reason: Reason::InstallFailed,
            label: Some(label),
            ..RunOptions::default()
        }
    }

    /// v1 `AcpRegistrySupport.ts:917-986`: an npm install of this exact package under the managed
    /// prefix, found through npm's own `root`/`prefix`. Messages name the manager `npm` and show
    /// prefixes under the home directory from `~` (final review 6 finding C2).
    async fn discover_npm_global_package(
        &self,
        agent: &Agent,
        package_spec: &str,
        manager: &str,
        managed_prefix: &Path,
        env: &Environment,
    ) -> Result<Option<PackageInstallReceipt>, RegistryError> {
        let identity = parse_npx_package_spec(package_spec);
        let prefix_args = |verb: &str| {
            vec![
                verb.to_owned(),
                "--global".into(),
                "--prefix".into(),
                managed_prefix.to_string_lossy().into_owned(),
            ]
        };
        let label = "npm";
        let root_out = run_command(
            manager,
            &prefix_args("root"),
            Self::query_options(env, label),
        )
        .await?;
        let global_root = Self::parse_package_manager_path(label, &root_out)?;
        let prefix_out = run_command(
            manager,
            &prefix_args("prefix"),
            Self::query_options(env, label),
        )
        .await?;
        let global_prefix = Self::parse_package_manager_path(label, &prefix_out)?;
        if !command_path::is_same_resolved_path(&global_prefix, managed_prefix, &self.platform) {
            let homes = install_homes(Some(env));
            let shown = |path: &Path| {
                crate::probe::support::redact_home(&path.display().to_string(), &homes)
            };
            return Err(RegistryError::new(
                Reason::InstallFailed,
                format!(
                    "'{label}' reported global prefix {} instead of GOAT's managed prefix {}. It may be a shim that ignores --prefix; put a real npm first on PATH.",
                    shown(&global_prefix),
                    shown(managed_prefix)
                ),
            ));
        }
        let package_root = identity.name.split('/').fold(global_root, |p, s| p.join(s));
        let manifest_path = package_root.join("package.json");
        match tokio::fs::metadata(&manifest_path).await {
            Ok(m) if m.len() <= MAX_PACKAGE_MANIFEST_BYTES => {}
            _ => return Ok(None),
        }
        let Some(manifest) = tokio::fs::read_to_string(&manifest_path)
            .await
            .ok()
            .and_then(|t| decode_npm_manifest(&t))
        else {
            return Ok(None);
        };
        if manifest.name != identity.name || manifest.version != identity.version {
            return Ok(None);
        }
        let Some(command_name) = npm_command_name(&agent.id, &identity.name, &manifest) else {
            return Ok(None);
        };
        let bin_directory = if self.platform == "win32" {
            global_prefix.clone()
        } else {
            global_prefix.join("bin")
        };
        let candidate = bin_directory.join(&command_name);
        let Some(executable) = self.resolve_executable(&candidate.to_string_lossy(), env) else {
            return Ok(None);
        };
        Ok(Some(PackageInstallReceipt {
            agent_id: agent.id.clone(),
            agent_version: agent.version.clone(),
            distribution: PackageKind::Npx,
            package_spec: package_spec.into(),
            manager_path: manager.into(),
            bin_directory: bin_directory.to_string_lossy().into_owned(),
            executable_path: executable.to_string_lossy().into_owned(),
            package_root: Some(package_root.to_string_lossy().into_owned()),
            package_version: Some(manifest.version),
        }))
    }

    /// v1 `AcpRegistrySupport.ts:988-1034`: `uv tool list` shows this exact version, and one of the
    /// command candidates is in `uv tool dir --bin`.
    async fn discover_uv_global_package(
        &self,
        agent: &Agent,
        package_spec: &str,
        manager: &str,
        env: &Environment,
    ) -> Result<Option<PackageInstallReceipt>, RegistryError> {
        let identity = parse_uvx_package_spec(package_spec);
        let label = "uv";
        let listed = run_command(
            manager,
            &["tool".into(), "list".into()],
            Self::query_options(env, label),
        )
        .await?;
        let separators = regex::Regex::new(r"[._-]+").expect("static regex");
        let normalize = |s: &str| separators.replace_all(&s.to_lowercase(), "-").into_owned();
        let wanted = normalize(&identity.name);
        let line = regex::Regex::new(r"^(\S+) v(\S+)(?:\s|$)").expect("static regex");
        let installed = listed.split('\n').any(|l| {
            let l = l.strip_suffix('\r').unwrap_or(l);
            line.captures(l)
                .is_some_and(|c| normalize(&c[1]) == wanted && c[2] == identity.version)
        });
        if !installed {
            return Ok(None);
        }
        let dir_out = run_command(
            manager,
            &["tool".into(), "dir".into(), "--bin".into()],
            Self::query_options(env, label),
        )
        .await?;
        let bin_directory = Self::parse_package_manager_path(label, &dir_out)?;
        let mut bin_env = env.clone();
        bin_env.insert("PATH".into(), bin_directory.to_string_lossy().into_owned());
        let executable = package_command_candidates(&agent.id, &identity.name)
            .iter()
            .find_map(|c| self.resolve_executable(c, &bin_env));
        Ok(executable.map(|executable| PackageInstallReceipt {
            agent_id: agent.id.clone(),
            agent_version: agent.version.clone(),
            distribution: PackageKind::Uvx,
            package_spec: package_spec.into(),
            manager_path: manager.into(),
            bin_directory: bin_directory.to_string_lossy().into_owned(),
            executable_path: executable.to_string_lossy().into_owned(),
            package_root: None,
            package_version: Some(identity.version),
        }))
    }

    /// v1 `AcpRegistrySupport.ts:1036-1151`: install the package into GOAT's managed prefix (npm
    /// `install --global <spec> --prefix <root>`, uv `tool install --force <spec>` with
    /// `UV_TOOL_DIR`/`UV_TOOL_BIN_DIR`), reusing a matching receipt or existing install.
    pub async fn ensure_global_package(
        &self,
        agent: &Agent,
        kind: PackageKind,
        package_spec: &str,
        env: &Environment,
    ) -> Result<PackageInstallReceipt, RegistryError> {
        let manager_name = package_manager_for(kind.distribution()).unwrap_or("npm");
        let Some(manager_path) = self.resolve_executable(manager_name, env) else {
            return Err(RegistryError::new(
                Reason::RunnerUnavailable,
                format!(
                    "ACP Registry agent {} requires '{manager_name}', but it is not available on this environment's PATH.",
                    agent.id
                ),
            ));
        };
        let manager = manager_path.to_string_lossy().into_owned();
        let receipt = self
            .read_package_receipt(agent, kind, package_spec, &manager)
            .await;
        if kind == PackageKind::Npx
            && let Some(receipt) = receipt.clone()
        {
            return Ok(receipt);
        }
        let package_root = self.package_install_root(agent, kind);
        tokio::fs::create_dir_all(&package_root)
            .await
            .map_err(|_| {
                RegistryError::new(
                    Reason::InstallFailed,
                    format!(
                        "Could not create the managed install directory for {}.",
                        agent.id
                    ),
                )
            })?;
        let package_env = match kind {
            PackageKind::Npx => {
                let mut env = command_path::without_npm_prefix(env, &self.platform);
                env.insert(
                    "npm_config_prefix".into(),
                    package_root.to_string_lossy().into_owned(),
                );
                env
            }
            PackageKind::Uvx => {
                let mut env = env.clone();
                env.insert(
                    "UV_TOOL_DIR".into(),
                    package_root.to_string_lossy().into_owned(),
                );
                env.insert(
                    "UV_TOOL_BIN_DIR".into(),
                    self.package_bin_directory(agent, kind)
                        .to_string_lossy()
                        .into_owned(),
                );
                env
            }
        };
        if receipt.is_some()
            && let Some(installed) = self
                .discover_uv_global_package(agent, package_spec, &manager, &package_env)
                .await?
        {
            return Ok(installed);
        }
        let discover = || async {
            match kind {
                PackageKind::Npx => {
                    self.discover_npm_global_package(
                        agent,
                        package_spec,
                        &manager,
                        &package_root,
                        &package_env,
                    )
                    .await
                }
                PackageKind::Uvx => {
                    self.discover_uv_global_package(agent, package_spec, &manager, &package_env)
                        .await
                }
            }
        };
        if let Some(existing) = discover().await? {
            self.write_package_receipt(&existing).await?;
            return Ok(existing);
        }
        let manager_directory = command_path::manager_bin_directory(&manager_path);
        let install_env =
            command_path::with_preferred_path(&package_env, &manager_directory, &self.platform);
        let args: Vec<String> = match kind {
            PackageKind::Npx => vec![
                "install".into(),
                "--global".into(),
                package_spec.into(),
                "--prefix".into(),
                package_root.to_string_lossy().into_owned(),
            ],
            PackageKind::Uvx => vec![
                "tool".into(),
                "install".into(),
                "--force".into(),
                package_spec.into(),
            ],
        };
        run_command(
            &manager,
            &args,
            RunOptions {
                env: Some(&install_env),
                timeout: Some(PACKAGE_INSTALL_TIMEOUT),
                truncated_reason: Reason::InstallFailed,
                label: Some(manager_name),
                ..RunOptions::default()
            },
        )
        .await?;
        let Some(installed) = discover().await? else {
            return Err(RegistryError::new(
                Reason::InstallFailed,
                format!(
                    "ACP Registry installed {package_spec}, but could not resolve its global command."
                ),
            ));
        };
        self.write_package_receipt(&installed).await?;
        Ok(installed)
    }

    /// v1 `AcpRegistrySupport.ts:1153-1178`: an exclusive lock file; a lock untouched for five
    /// minutes is stale and removed.
    async fn acquire_install_lock(lock: &Path) -> Result<(), Fault> {
        for _ in 0..INSTALL_LOCK_RETRY_COUNT {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(lock)
            {
                Ok(_) => return Ok(()),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            let modified = std::fs::metadata(lock).and_then(|m| m.modified()).ok();
            if modified
                .and_then(|m| SystemTime::now().duration_since(m).ok())
                .is_some_and(|age| age > INSTALL_LOCK_STALE)
            {
                let _ = std::fs::remove_file(lock);
                continue;
            }
            tokio::time::sleep(INSTALL_LOCK_RETRY_DELAY).await;
        }
        Err(RegistryError::new(
            Reason::InstallFailed,
            format!(
                "Timed out waiting for ACP Registry install lock {}.",
                lock.display()
            ),
        )
        .into())
    }

    /// v1 `AcpRegistrySupport.ts:1180-1207`: the command's real path is inside the install root
    /// and is a regular executable file; only then is it made executable.
    pub(crate) fn assert_executable_in_root(
        &self,
        root: &Path,
        executable: &Path,
        make_executable: bool,
    ) -> Result<PathBuf, Fault> {
        let root_real = std::fs::canonicalize(root)?;
        let executable_real = std::fs::canonicalize(executable)?;
        if !executable_real.starts_with(&root_real) {
            return Err(RegistryError::new(
                Reason::ArchiveInvalid,
                "ACP Registry archive command resolves outside its installation directory.",
            )
            .into());
        }
        // chmod follows symlinks, so only change the mode once the real path is known to be inside.
        #[cfg(unix)]
        if make_executable && self.platform != "win32" {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable_real, std::fs::Permissions::from_mode(0o755))?;
        }
        let info = std::fs::metadata(&executable_real)?;
        #[cfg(unix)]
        let executable_mode = {
            use std::os::unix::fs::PermissionsExt;
            self.platform == "win32" || info.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable_mode = true;
        if !info.is_file() || !executable_mode {
            return Err(RegistryError::new(
                Reason::ArchiveInvalid,
                "ACP Registry archive command is not a regular executable file.",
            )
            .into());
        }
        Ok(executable_real)
    }

    /// v1 `AcpRegistrySupport.ts:1209-1223`. The platform directory is the candidate whose entry
    /// equals `target` (v1 compares the object it resolved).
    pub fn binary_paths(&self, agent: &Agent, target: &BinaryTarget) -> Option<BinaryPaths> {
        let segments = archive::normalize_registry_command_path(&target.cmd)?;
        let own = self.platform_target();
        let matched = platform_candidates(own)
            .into_iter()
            .find(|c| agent.distribution.binary.as_ref().and_then(|b| b.get(*c)) == Some(target))
            .or(own)?;
        let install_root = self.agent_install_root(agent).join(matched);
        let executable_path = segments.iter().fold(install_root.clone(), |p, s| p.join(s));
        Some(BinaryPaths {
            command_segments: segments,
            install_root,
            platform_target: matched,
            executable_path,
        })
    }

    /// v1 `AcpRegistrySupport.ts:1225-1244`: any version installed for this platform.
    pub fn has_installed_binary_version(&self, agent_id: &str) -> bool {
        let agent_root = self.tools_dir.join(agent_id);
        let Ok(versions) = std::fs::read_dir(&agent_root) else {
            return false;
        };
        versions.flatten().any(|version| {
            platform_candidates(self.platform_target())
                .into_iter()
                .any(|t| exists(&version.path().join(t)))
        })
    }

    /// v1 `AcpRegistrySupport.ts:1246-1444`: download, verify, extract into a temp directory next
    /// to the install root, then move it into place under the install lock.
    pub async fn install_binary(
        &self,
        agent: &Agent,
        target: &BinaryTarget,
    ) -> Result<PathBuf, RegistryError> {
        if self.platform_target().is_none() {
            return Err(RegistryError::new(
                Reason::UnsupportedPlatform,
                format!(
                    "ACP Registry does not support platform {}-{}.",
                    self.platform, self.architecture
                ),
            ));
        }
        let Some(paths) = self.binary_paths(agent, target) else {
            return Err(RegistryError::new(
                Reason::ArchiveInvalid,
                format!(
                    "ACP Registry agent {} declares an unsafe command path '{}'.",
                    agent.id, target.cmd
                ),
            ));
        };
        if exists(&paths.executable_path) {
            return self
                .assert_executable_in_root(&paths.install_root, &paths.executable_path, false)
                .or_registry(
                    Reason::InstallFailed,
                    format!("Could not validate cached ACP Registry agent {}.", agent.id),
                );
        }
        let parent = paths
            .install_root
            .parent()
            .unwrap_or(&self.tools_dir)
            .to_path_buf();
        tokio::fs::create_dir_all(&parent).await.map_err(|_| {
            RegistryError::new(
                Reason::InstallFailed,
                format!("Could not create ACP Registry cache for {}.", agent.id),
            )
        })?;
        let lock = PathBuf::from(format!("{}.lock", paths.install_root.display()));
        Self::acquire_install_lock(&lock).await.or_registry(
            Reason::InstallFailed,
            format!(
                "Could not acquire install lock for ACP Registry agent {}.",
                agent.id
            ),
        )?;
        let _lock = LockGuard(lock);
        self.install_locked(agent, target, &paths, &parent)
            .await
            .or_registry(
                Reason::InstallFailed,
                format!("Could not install ACP Registry agent {}.", agent.id),
            )
    }

    async fn install_locked(
        &self,
        agent: &Agent,
        target: &BinaryTarget,
        paths: &BinaryPaths,
        parent: &Path,
    ) -> Result<PathBuf, Fault> {
        if exists(&paths.executable_path) {
            return self.assert_executable_in_root(
                &paths.install_root,
                &paths.executable_path,
                false,
            );
        }
        let temporary = TempDir(super::runtime_temp::make_temp_directory(
            parent,
            &format!(".{}-install-", agent.id),
        )?);
        let extraction_root = temporary.0.join("extracted");
        std::fs::create_dir_all(&extraction_root)?;
        let kind = archive::archive_kind(&target.archive);
        let archive_path = temporary.0.join(archive::archive_file_name(kind));
        self.download(agent, target, &archive_path).await?;

        if kind == ArchiveKind::Raw {
            let staged = paths
                .command_segments
                .iter()
                .fold(extraction_root.clone(), |p, s| p.join(s));
            if let Some(dir) = staged.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::rename(&archive_path, &staged)?;
        } else {
            let (archive_path, extraction) = (archive_path.clone(), extraction_root.clone());
            let id = agent.id.clone();
            let tool = if kind == ArchiveKind::Zip && self.platform != "win32" {
                "unzip"
            } else {
                "tar"
            };
            tokio::task::spawn_blocking(move || -> Result<(), Fault> {
                // Final review 6 finding C1: past the expansion limit is an invalid archive.
                let too_large = || {
                    Fault::from(RegistryError::new(
                        Reason::ArchiveInvalid,
                        format!(
                            "ACP Registry agent {id} archive expands past {} GiB or {} entries.",
                            archive::MAX_EXTRACTED_BYTES / (1024 * 1024 * 1024),
                            archive::MAX_ARCHIVE_ENTRIES
                        ),
                    ))
                };
                let listed = match archive::list_entries(kind, &archive_path) {
                    Err(e) if e.kind() == io::ErrorKind::FileTooLarge => return Err(too_large()),
                    listed => listed?,
                };
                let Some(listing) = listed else {
                    return Err(RegistryError::new(
                        Reason::ArchiveInvalid,
                        format!("ACP Registry install command '{tool}' produced more output than expected."),
                    )
                    .into());
                };
                if !archive::validate_archive_entries(&listing) {
                    return Err(RegistryError::new(
                        Reason::ArchiveInvalid,
                        format!("ACP Registry agent {id} archive contains an unsafe path."),
                    )
                    .into());
                }
                archive::extract(kind, &archive_path, &extraction).map_err(|e| {
                    if e.kind() == io::ErrorKind::FileTooLarge {
                        return too_large();
                    }
                    if e.kind() == io::ErrorKind::InvalidData {
                        RegistryError::new(
                            Reason::ArchiveInvalid,
                            format!("ACP Registry agent {id} archive contains an unsafe path."),
                        )
                    } else {
                        RegistryError::new(
                            Reason::InstallFailed,
                            format!("ACP Registry install command '{tool}' exited with code 1: {e}"),
                        )
                    }
                    .into()
                })
            })
            .await
            .map_err(|_| Fault::Other)??;
        }

        let staged = paths
            .command_segments
            .iter()
            .fold(extraction_root.clone(), |p, s| p.join(s));
        if std::fs::symlink_metadata(&staged).is_err() {
            return Err(RegistryError::new(
                Reason::ArchiveInvalid,
                format!(
                    "ACP Registry archive for {} did not contain '{}'.",
                    agent.id, target.cmd
                ),
            )
            .into());
        }
        self.assert_executable_in_root(&extraction_root, &staged, true)?;
        let _ = std::fs::remove_dir_all(&paths.install_root);
        std::fs::rename(&extraction_root, &paths.install_root)?;
        self.assert_executable_in_root(&paths.install_root, &paths.executable_path, false)
    }

    /// v1 `AcpRegistrySupport.ts:1313-1380`: stream to disk while hashing, within 1 GiB.
    async fn download(
        &self,
        agent: &Agent,
        target: &BinaryTarget,
        archive_path: &Path,
    ) -> Result<(), Fault> {
        let (id, version) = (&agent.id, &agent.version);
        let mut stream = match tokio::time::timeout(
            ARCHIVE_REQUEST_TIMEOUT,
            self.download.open(&target.archive),
        )
        .await
        {
            Err(_) => {
                return Err(RegistryError::new(
                    Reason::DownloadFailed,
                    format!("Timed out downloading ACP Registry agent {id} {version}."),
                )
                .into());
            }
            Ok(Err(_)) => {
                return Err(RegistryError::new(
                    Reason::DownloadFailed,
                    format!("Could not download ACP Registry agent {id} {version}."),
                )
                .into());
            }
            Ok(Ok(stream)) => stream,
        };
        let save_failed = || -> Fault {
            RegistryError::new(
                Reason::DownloadFailed,
                format!("Could not save ACP Registry agent {id} {version}."),
            )
            .into()
        };
        let mut hash = Sha256::new();
        let read = async {
            let mut file = tokio::fs::File::create(archive_path)
                .await
                .map_err(|_| save_failed())?;
            let mut downloaded: u64 = 0;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| save_failed())?;
                if downloaded + chunk.len() as u64 > MAX_ARCHIVE_BYTES {
                    return Err(RegistryError::new(
                        Reason::ArchiveInvalid,
                        format!(
                            "ACP Registry agent {id} archive exceeds {MAX_ARCHIVE_BYTES} bytes."
                        ),
                    )
                    .into());
                }
                downloaded += chunk.len() as u64;
                hash.update(&chunk);
                file.write_all(&chunk).await.map_err(|_| save_failed())?;
            }
            file.flush().await.map_err(|_| save_failed())?;
            Ok::<(), Fault>(())
        };
        match tokio::time::timeout(ARCHIVE_REQUEST_TIMEOUT, read).await {
            Err(_) => {
                return Err(RegistryError::new(
                    Reason::DownloadFailed,
                    format!("Timed out reading ACP Registry agent {id} download."),
                )
                .into());
            }
            Ok(result) => result?,
        }
        if let Some(expected) = &target.sha256 {
            let actual: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
            if actual != expected.to_lowercase() {
                return Err(RegistryError::new(
                    Reason::ChecksumMismatch,
                    format!("ACP Registry agent {id} download did not match its declared SHA-256."),
                )
                .into());
            }
        }
        Ok(())
    }

    /// v1 `AcpRegistrySupport.ts:229-318`: directories holding managed registry commands (package
    /// bin directories with a valid receipt, then installed binaries for this platform).
    pub fn managed_binary_directories(&self) -> Vec<PathBuf> {
        let mut directories: Vec<PathBuf> = Vec::new();
        let list = |dir: &Path| -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(dir)
                .map(|it| {
                    it.flatten()
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            names
        };
        let receipts = self.package_receipts_directory();
        for file in list(&receipts) {
            let Some(receipt) = std::fs::read_to_string(receipts.join(&file))
                .ok()
                .and_then(|t| decode_receipt(&t))
            else {
                continue;
            };
            let mut expected = self
                .tools_dir
                .join(&receipt.agent_id)
                .join(encode_uri_component(&receipt.agent_version))
                .join(match receipt.distribution {
                    PackageKind::Npx => "npm",
                    PackageKind::Uvx => "python",
                });
            if !(receipt.distribution == PackageKind::Npx && self.platform == "win32") {
                expected = expected.join("bin");
            }
            if same_string_path(&receipt.bin_directory, &expected)
                && parent_is(&receipt.executable_path, &receipt.bin_directory)
                && exists(Path::new(&receipt.executable_path))
            {
                directories.push(PathBuf::from(&receipt.bin_directory));
            }
        }
        let Some(target) = self.platform_target() else {
            return dedupe(directories);
        };
        let cached = std::fs::read(self.registry_directory().join("registry.json"))
            .ok()
            .and_then(|b| super::index::decode(&b).ok())
            .map(|i| i.agents)
            .unwrap_or_default();
        for agent in list(&self.tools_dir) {
            let mut versions = list(&self.tools_dir.join(&agent));
            versions.sort_by(|a, b| numeric_compare(b, a));
            for version in versions {
                for candidate in platform_candidates(Some(target)) {
                    let install_root = self.tools_dir.join(&agent).join(&version).join(candidate);
                    if !exists(&install_root) {
                        continue;
                    }
                    let segments = cached
                        .iter()
                        .find(|a| a.id == agent && encode_uri_component(&a.version) == version)
                        .and_then(|a| a.distribution.binary.as_ref()?.get(candidate))
                        .and_then(|t| archive::normalize_registry_command_path(&t.cmd));
                    let directory = match segments {
                        None => install_root,
                        Some(s) => s[..s.len() - 1].iter().fold(install_root, |p, s| p.join(s)),
                    };
                    if exists(&directory) {
                        directories.push(directory);
                    }
                }
            }
        }
        dedupe(directories)
    }

    /// v1 `AcpRegistrySupport.ts:1903-1943`: remove every platform directory of the agent, then
    /// empty version and agent directories. Returns whether anything was removed.
    pub fn remove_managed_binaries(&self, agent_id: &str) -> Result<bool, RegistryError> {
        let agent_root = self.tools_dir.join(agent_id);
        let existed = agent_root.try_exists().map_err(|_| {
            RegistryError::new(
                Reason::InstallFailed,
                format!(
                    "Could not inspect the managed binary cache for ACP Registry agent {agent_id}."
                ),
            )
        })?;
        if !existed {
            return Ok(false);
        }
        let platform_dir = regex::Regex::new(r"^(?:darwin|linux|windows)-(?:aarch64|x86_64)$")
            .expect("static regex");
        let mut removed = false;
        let mut remove = || -> io::Result<()> {
            for version in std::fs::read_dir(&agent_root)? {
                let version_root = version?.path();
                for entry in std::fs::read_dir(&version_root)? {
                    let entry = entry?;
                    if !platform_dir.is_match(&entry.file_name().to_string_lossy()) {
                        continue;
                    }
                    let path = entry.path();
                    if path.is_dir() {
                        std::fs::remove_dir_all(&path)?;
                    } else {
                        std::fs::remove_file(&path)?;
                    }
                    removed = true;
                }
                if std::fs::read_dir(&version_root)?.next().is_none() {
                    std::fs::remove_dir(&version_root)?;
                }
            }
            if std::fs::read_dir(&agent_root)?.next().is_none() {
                std::fs::remove_dir(&agent_root)?;
            }
            Ok(())
        };
        remove().map_err(|_| {
            RegistryError::new(
                Reason::InstallFailed,
                format!("Could not remove managed binaries for ACP Registry agent {agent_id}."),
            )
        })?;
        Ok(removed)
    }
}

fn dedupe(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in paths {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_components_and_numeric_version_order() {
        assert_eq!(encode_uri_component("1.2.3+build"), "1.2.3%2Bbuild");
        let mut versions = vec!["1.10.0", "1.9.0", "1.2.0"];
        versions.sort_by(|a, b| numeric_compare(b, a));
        assert_eq!(versions, ["1.10.0", "1.9.0", "1.2.0"]);
    }

    /// Yields some output, then a read error.
    #[derive(Default)]
    struct FailingRead {
        sent: bool,
    }
    impl tokio::io::AsyncRead for FailingRead {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            if self.sent {
                return std::task::Poll::Ready(Err(io::Error::other("read failed")));
            }
            self.sent = true;
            buf.put_slice(b"partial");
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// A failed read of a command's output is a failure, never a truncated success (v1
    /// AcpRegistrySupport.ts:742-758 fails the command when a stream fails; final review
    /// finding 13).
    #[tokio::test]
    async fn command_output_read_errors_fail() {
        assert!(
            read_capped(&mut FailingRead::default(), 1024)
                .await
                .is_err()
        );
        assert!(read_tail(&mut FailingRead::default()).await.is_err());
    }

    /// A redirect the policy stops (here: away from HTTPS) is not a download: only a 2xx final
    /// response is (v1 AcpRegistrySupport.ts:1313-1315 `filterStatusOk`; final review finding 6).
    /// The failure must be the 302 itself: a connection that never reached the server fails here
    /// at once instead of passing and then waiting forever for the server's accept.
    #[tokio::test]
    async fn a_stopped_redirect_is_not_a_download() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                assert_eq!(socket.read(&mut byte).await.unwrap(), 1);
                head.push(byte[0]);
            }
            let body = "#!/bin/sh\n";
            let reply = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{addr}/agent\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        });
        let download = HttpsDownload::new().unwrap();
        let opened = http_stream(&download.client, &format!("http://{addr}/start")).await;
        let Err(error) = opened else {
            panic!("a 302 body was accepted as the download")
        };
        assert!(error.contains("302"), "{error}");
        server.await.unwrap();
    }

    #[test]
    fn receipts_use_v1_field_names_and_bounds() {
        let r = PackageInstallReceipt {
            agent_id: "a".into(),
            agent_version: "1.0.0".into(),
            distribution: PackageKind::Uvx,
            package_spec: "a==1.0.0".into(),
            manager_path: "/bin/uv".into(),
            bin_directory: "/t/bin".into(),
            executable_path: "/t/bin/a".into(),
            package_root: None,
            package_version: Some("1.0.0".into()),
        };
        let text = serde_json::to_string(&r).unwrap();
        assert_eq!(
            text,
            r#"{"agentId":"a","agentVersion":"1.0.0","distribution":"uvx","packageSpec":"a==1.0.0","managerPath":"/bin/uv","binDirectory":"/t/bin","executablePath":"/t/bin/a","packageVersion":"1.0.0"}"#
        );
        assert_eq!(decode_receipt(&text), Some(r));
        assert!(decode_receipt(&text.replace("\"a\"", "\"../a\"")).is_none());
    }

    #[test]
    fn package_manager_paths_must_be_one_absolute_line() {
        assert_eq!(
            Installer::parse_package_manager_path("npm", "\n/x/lib/node_modules\r\n").unwrap(),
            PathBuf::from("/x/lib/node_modules")
        );
        for bad in ["relative\n", "/a\n/b\n", ""] {
            assert_eq!(
                Installer::parse_package_manager_path("npm", bad)
                    .unwrap_err()
                    .detail,
                "ACP Registry package manager 'npm' returned an invalid global path."
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_command_reports_exit_tail_truncation_and_timeout() {
        let sh = |script: &str| vec!["-c".to_string(), script.to_string()];
        let out = run_command("/bin/sh", &sh("printf ok"), RunOptions::default())
            .await
            .unwrap();
        assert_eq!(out, "ok");
        let long = "x".repeat(1_500);
        let failed = run_command(
            "/bin/sh",
            &sh(&format!("printf '{long}END' >&2; exit 3")),
            RunOptions::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(failed.reason, Reason::InstallFailed);
        let prefix = "ACP Registry install command '/bin/sh' exited with code 3: ";
        assert!(failed.detail.starts_with(prefix));
        assert_eq!(
            failed.detail.len() - prefix.len(),
            MAX_COMMAND_ERROR_TAIL_CHARS
        );
        assert!(failed.detail.ends_with("END"));
        let truncated = run_command(
            "/bin/sh",
            &sh("printf 0123456789"),
            RunOptions {
                max_stdout: 4,
                ..RunOptions::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(truncated.reason, Reason::ArchiveInvalid);
        assert_eq!(
            truncated.detail,
            "ACP Registry install command '/bin/sh' produced more output than expected."
        );
        let missing = run_command("/nonexistent/npm", &[], RunOptions::default())
            .await
            .unwrap_err();
        assert_eq!(
            missing.detail,
            "Could not run ACP Registry install command '/nonexistent/npm'."
        );
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn run_command_timeout_kills_the_child() {
        let timed_out = run_command(
            "/bin/sh",
            &["-c".to_string(), "read never".to_string()],
            RunOptions {
                timeout: Some(PACKAGE_QUERY_TIMEOUT),
                ..RunOptions::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            timed_out.detail,
            "Timed out running ACP Registry install command '/bin/sh'."
        );
    }
}
