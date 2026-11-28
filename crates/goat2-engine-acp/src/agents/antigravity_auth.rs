//! Antigravity sign-in, credentials and launch environment.
//!
//! v1 `apps/server/src/provider/antigravityAuthSupport.ts` at 916b5ccc1b2: the sign-in URL the
//! runtime prints (:30-44, :556-626), stdout and stderr handling (:628-742), the sign-in-required
//! errors (:171-181), the credential source and environment (:65-159, :206-248), the instance
//! directories (:183-200), the browser suppression command (:58-63, :202-204, :382-396) and the
//! spawn arguments (:513-554). Profile linking of user skills and rules and the browser preflight
//! run a Node helper in v1 and are not carried (see provenance/antigravity-fx.md).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::flavor::{StderrLine, StdoutLine};

/// v1 `ANTIGRAVITY_AUTH_STDOUT_PREFIX` (:30-31).
pub const ANTIGRAVITY_AUTH_STDOUT_PREFIX: &str =
    "Open the following link to authenticate the ACP server: ";
/// v1 `ANTIGRAVITY_AUTH_BROWSER_MARKER` (:32): what the browser helper prints on stderr.
pub const ANTIGRAVITY_AUTH_BROWSER_MARKER: &str = "__GOAT_ANTIGRAVITY_AUTH_URL__";
/// v1 `ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE` (:33-34).
pub const ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE: &str =
    "Sign in to Antigravity in Settings before you continue.";
/// v1 the transport error for an unparseable sign-in URL (:564-565).
pub const ANTIGRAVITY_INVALID_SIGN_IN_URL: &str =
    "Antigravity returned an invalid Google sign-in URL.";
/// v1 the harness-failure transport error (:711-716).
pub const ANTIGRAVITY_HARNESS_FAILURE_MESSAGE: &str =
    "Antigravity's local agent connection failed. Send a follow-up to resume with a fresh process.";
/// v1 `NATIVE_CLI_NO_BROWSER_PREFIX` (:171-172): the 1.5 CLI's `authenticate` error without a display.
pub const NATIVE_CLI_NO_BROWSER_PREFIX: &str = "No browser is available here";

const MAX_AUTHORIZATION_URL_LENGTH: usize = 16_384;
const fn max(a: usize, b: usize) -> usize {
    if a > b { a } else { b }
}
/// v1 `maxBrowserHelperLineLength` (:37-40).
const MAX_BROWSER_HELPER_LINE_LENGTH: usize = max(
    ANTIGRAVITY_AUTH_BROWSER_MARKER.len(),
    ANTIGRAVITY_AUTH_STDOUT_PREFIX.len(),
) + MAX_AUTHORIZATION_URL_LENGTH
    + 2;
/// v1 `ANTIGRAVITY_CODE_REDIRECT_URI` (:556-557).
const ANTIGRAVITY_CODE_REDIRECT_URI: &str = "https://antigravity.google/oauth-callback";

/// v1 `ANTIGRAVITY_HARNESS_FAILURE_LOG` (:694-696): glog records after which the harness's ACP
/// process can no longer run a turn.
static HARNESS_FAILURE_LOG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+ +\d+ (?:local_connection\.py:\d+\] harness stderr: Agent run failed:|server\.py:\d+\] (?:Failed to rebuild agent for session |Agent connection lost for session ))",
    )
    .expect("harness failure pattern")
});
static LOOPBACK_REDIRECT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^http://127\.0\.0\.1:[1-9][0-9]{0,4}/$").expect("loopback pattern")
});

/// v1 `/^[\w./~-]{1,2048}$/` (JavaScript `\w` is ASCII).
fn is_login_code(value: &str) -> bool {
    (1..=2048).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'~' | b'-'))
}

/// v1 `AntigravityAuthMethod` (contracts settings.ts:730-738).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AntigravityAuthMethod {
    #[default]
    OauthPersonal,
    OauthBusiness,
    GeminiApiKey,
    AgentPlatform,
}

impl AntigravityAuthMethod {
    /// The ACP auth method id (and `settings.json` `auth.type`).
    pub fn id(self) -> &'static str {
        match self {
            Self::OauthPersonal => "oauth-personal",
            Self::OauthBusiness => "oauth-business",
            Self::GeminiApiKey => "gemini-api-key",
            Self::AgentPlatform => "agent-platform",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        [
            Self::OauthPersonal,
            Self::OauthBusiness,
            Self::GeminiApiKey,
            Self::AgentPlatform,
        ]
        .into_iter()
        .find(|method| method.id() == id)
    }

    /// v1 `antigravityAuthUsesBrowser` (:112-114).
    pub fn uses_browser(self) -> bool {
        matches!(self, Self::OauthPersonal | Self::OauthBusiness)
    }

    /// v1 `antigravityAuthLabel` (:116-127).
    pub fn label(self) -> &'static str {
        match self {
            Self::OauthPersonal => "Google account",
            Self::OauthBusiness => "Gemini Enterprise",
            Self::GeminiApiKey => "Gemini API key",
            Self::AgentPlatform => "Agent Platform",
        }
    }
}

/// v1 `AntigravityAuthConfig` (:98-110). Never logged; the key only reaches the agent's environment.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct AntigravityAuthConfig {
    pub auth_method: AntigravityAuthMethod,
    pub api_key: String,
    pub gcp_project: String,
    pub gcp_location: String,
}

impl std::fmt::Debug for AntigravityAuthConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AntigravityAuthConfig")
            .field("auth_method", &self.auth_method)
            .field("api_key", &(!self.api_key.is_empty()).then_some("<set>"))
            .field("gcp_project", &self.gcp_project)
            .field("gcp_location", &self.gcp_location)
            .finish()
    }
}

impl AntigravityAuthConfig {
    /// v1 `antigravityAuthConfigIssue` (:129-144).
    pub fn issue(&self) -> Option<&'static str> {
        let gcp = !self.gcp_project.is_empty() && !self.gcp_location.is_empty();
        match self.auth_method {
            AntigravityAuthMethod::OauthPersonal => None,
            AntigravityAuthMethod::OauthBusiness => (!gcp).then_some(
                "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.",
            ),
            AntigravityAuthMethod::GeminiApiKey => self
                .api_key
                .is_empty()
                .then_some("Enter a Gemini API key in the Antigravity provider settings."),
            AntigravityAuthMethod::AgentPlatform => (self.api_key.is_empty() && !gcp).then_some(
                "Agent Platform needs an API key, or a GCP project and location, in the Antigravity provider settings.",
            ),
        }
    }

    /// v1 `antigravityProfileSettings` (:146-159): `settings.json` names the method so a native
    /// logout clears only its credentials. Never holds a credential.
    pub fn profile_settings(&self) -> String {
        let mut settings = json!({"auth": {"type": self.auth_method.id()}});
        let mut gcp = serde_json::Map::new();
        if !self.gcp_project.is_empty() {
            gcp.insert("project".into(), json!(self.gcp_project));
        }
        if !self.gcp_location.is_empty() {
            gcp.insert("location".into(), json!(self.gcp_location));
        }
        if !gcp.is_empty() {
            settings["gcp"] = Value::Object(gcp);
        }
        format!("{settings}\n")
    }
}

/// v1 `AntigravityAuthorizationUrl` (:161-165).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationUrl {
    pub authorization_url: String,
    pub redirect_uri: String,
    pub state: String,
}

/// Which sign-in printed the URL: the ACP server (loopback redirect) or `agy acp --login` (code).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationUrlKind {
    Loopback,
    Code,
}

/// v1 `parseAntigravityAuthorizationUrl` (:559-598): only Google's OAuth page with one state, one
/// `response_type=code` and the expected redirect.
pub fn parse_authorization_url(
    authorization_url: &str,
    kind: AuthorizationUrlKind,
) -> Result<AuthorizationUrl, &'static str> {
    let invalid = Err(ANTIGRAVITY_INVALID_SIGN_IN_URL);
    if authorization_url.len() > MAX_AUTHORIZATION_URL_LENGTH
        || authorization_url.chars().any(char::is_whitespace)
    {
        return invalid;
    }
    let Ok(url) = url::Url::parse(authorization_url) else {
        return invalid;
    };
    let all = |name: &str| -> Vec<String> {
        url.query_pairs()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .collect()
    };
    let states = all("state");
    let redirects = all("redirect_uri");
    let response_types = all("response_type");
    let path = match kind {
        AuthorizationUrlKind::Loopback => "/o/oauth2/v2/auth",
        AuthorizationUrlKind::Code => "/o/oauth2/auth",
    };
    let (Some(state), Some(redirect_uri)) = (states.first(), redirects.first()) else {
        return invalid;
    };
    if url.origin().ascii_serialization() != "https://accounts.google.com"
        || url.path() != path
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some_and(|f| !f.is_empty())
        || states.len() != 1
        || redirects.len() != 1
        || response_types.len() != 1
        || response_types[0] != "code"
        || state.is_empty()
        || state.chars().count() > 512
        || state.chars().any(char::is_whitespace)
        || match kind {
            AuthorizationUrlKind::Loopback => !LOOPBACK_REDIRECT.is_match(redirect_uri),
            AuthorizationUrlKind::Code => redirect_uri != ANTIGRAVITY_CODE_REDIRECT_URI,
        }
    {
        return invalid;
    }
    if kind == AuthorizationUrlKind::Loopback {
        let Ok(redirect) = url::Url::parse(redirect_uri) else {
            return invalid;
        };
        if redirect.port().unwrap_or(0) < 1_024 {
            return invalid;
        }
    }
    Ok(AuthorizationUrl {
        authorization_url: authorization_url.to_owned(),
        redirect_uri: redirect_uri.clone(),
        state: state.clone(),
    })
}

/// v1 `antigravityLoginResponse` (:600-626): what `agy acp --login` reads after its link, the code
/// the Antigravity page shows or that page's URL for this sign-in; None for anything else.
pub fn login_response(pending: &AuthorizationUrl, response: &str) -> Option<String> {
    if response.contains(['\r', '\n']) {
        return None;
    }
    let value = response.trim();
    if is_login_code(value) {
        return Some(value.to_owned());
    }
    if value.len() > MAX_AUTHORIZATION_URL_LENGTH || value.chars().any(char::is_whitespace) {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    let page = format!("{}{}", url.origin().ascii_serialization(), url.path());
    let states: Vec<_> = url.query_pairs().filter(|(k, _)| k == "state").collect();
    let codes: Vec<_> = url.query_pairs().filter(|(k, _)| k == "code").collect();
    (page == pending.redirect_uri
        && url.username().is_empty()
        && url.password().is_none()
        && states.len() == 1
        && states[0].1 == pending.state
        && codes.len() == 1
        && !codes[0].1.is_empty())
    .then(|| value.to_owned())
}

/// v1 `makeAntigravityStdoutTransform` (:628-692): the ACP server's sign-in link becomes a sign-in
/// request; an invalid link ends the connection.
pub fn stdout_line(line: &str) -> StdoutLine {
    let Some(url) = line.strip_prefix(ANTIGRAVITY_AUTH_STDOUT_PREFIX) else {
        return StdoutLine::Json;
    };
    match parse_authorization_url(url, AuthorizationUrlKind::Loopback) {
        Ok(parsed) => StdoutLine::AuthUrl(parsed.authorization_url),
        Err(message) => StdoutLine::Fail(message.to_owned()),
    }
}

/// v1 `makeAntigravityStderrHandler` (:698-742): a harness failure fails the turn; a sign-in link
/// (printed, or caught by the browser helper) becomes a sign-in request; invalid links are ignored.
pub fn stderr_line(line: &str) -> StderrLine {
    let message = line.strip_suffix('\r').unwrap_or(line);
    if message.len() > MAX_BROWSER_HELPER_LINE_LENGTH {
        return StderrLine::Ignore;
    }
    if HARNESS_FAILURE_LOG.is_match(message) {
        return StderrLine::Fail(ANTIGRAVITY_HARNESS_FAILURE_MESSAGE.to_owned());
    }
    let url = if let Some(url) = message.strip_prefix(ANTIGRAVITY_AUTH_STDOUT_PREFIX) {
        Some(url.to_owned())
    } else if let Some(encoded) = message.strip_prefix(ANTIGRAVITY_AUTH_BROWSER_MARKER) {
        serde_json::from_str::<String>(encoded).ok()
    } else {
        return StderrLine::Ignore;
    };
    match url.map(|url| parse_authorization_url(&url, AuthorizationUrlKind::Loopback)) {
        Some(Ok(parsed)) => StderrLine::AuthUrl(parsed.authorization_url),
        _ => StderrLine::Ignore,
    }
}

/// v1 `isAntigravitySignInRequiredError` (:174-181) for a JSON-RPC error.
pub fn is_sign_in_required(code: i32, message: &str) -> bool {
    code == -32000 || (code == -32603 && message.starts_with(NATIVE_CLI_NO_BROWSER_PREFIX))
}

/// v1 `AntigravityInstanceDirectories` (:183-200): the private profile and the runtime temp beside
/// it, keyed by the SHA-256 of the instance id so case-only differences stay apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityInstanceDirectories {
    pub profile: PathBuf,
    pub runtime_temp: PathBuf,
}

pub fn instance_directories(state_dir: &Path, instance_id: &str) -> AntigravityInstanceDirectories {
    let key: String = Sha256::digest(instance_id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    AntigravityInstanceDirectories {
        profile: state_dir.join("providers").join("antigravity").join(&key),
        runtime_temp: state_dir.join("antigravity-tmp").join(&key[..12]),
    }
}

/// v1 `browserHelperSource` (:58-62): prints the URL Python would open, with the marker, on stderr.
pub fn browser_helper_source() -> String {
    format!(
        "process.stderr.on(\"error\",()=>process.exit(0)).write(\"{ANTIGRAVITY_AUTH_BROWSER_MARKER}\"+JSON.stringify(process.argv[1])+\"\\n\",()=>process.exit(0))"
    )
}

/// v1 `quoteBrowserArgument` (:202-204).
fn quote_browser_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// v1 the `BROWSER` command (:382-396) for the Node (or Electron-as-Node) helper at
/// `helper_executable`. Python splits `BROWSER` on the path separator, so a command containing it,
/// a line break, NUL or `%s` cannot be used.
pub fn browser_command(helper_executable: &str, windows: bool) -> Result<String, &'static str> {
    let helper = if windows {
        helper_executable.replace('\\', "/")
    } else {
        helper_executable.to_owned()
    };
    let source = browser_helper_source();
    let command = [helper.as_str(), "-e", source.as_str(), "--", "%s"]
        .map(quote_browser_argument)
        .join(" ");
    if command.contains(if windows { ';' } else { ':' })
        || helper.contains(['\r', '\n', '\0'])
        || helper.contains("%s")
    {
        return Err(
            "The GOAT runtime path cannot be used to suppress Antigravity browser launches.",
        );
    }
    Ok(command)
}

/// v1 `AntigravityProfile` (:88-96).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravityProfile {
    pub windows: bool,
    pub linux: bool,
    pub gemini_home: PathBuf,
    pub acp_directory: PathBuf,
    pub token_path: PathBuf,
    pub temp_directory: PathBuf,
    pub browser_command: String,
    pub ca_bundle_path: Option<PathBuf>,
}

impl AntigravityProfile {
    /// v1 `prepareAntigravityProfile` paths (:398-430) for the profile at `profile_directory`.
    pub fn new(profile_directory: &Path, browser_command: String) -> Self {
        let gemini_home = profile_directory.to_path_buf();
        let acp_directory = gemini_home.join("antigravity-acp");
        Self {
            windows: cfg!(windows),
            linux: cfg!(target_os = "linux"),
            token_path: acp_directory.join("acp_token.json"),
            temp_directory: acp_directory.join("tmp"),
            gemini_home,
            acp_directory,
            browser_command,
            ca_bundle_path: None,
        }
    }

    /// v1 `prepareAntigravityProfile` (antigravityAuthSupport.ts:401-420): on Linux the bundled
    /// Python may look for certificates at paths this distribution lacks, so the first existing
    /// absolute candidate becomes `SSL_CERT_FILE` (round 7 part 5a.7). A bundle already chosen is
    /// kept; other platforms get none.
    pub fn with_linux_ca_bundle(mut self, base_env: &HashMap<String, String>) -> Self {
        if !self.linux || self.ca_bundle_path.is_some() {
            return self;
        }
        let nix = base_env.get("NIX_SSL_CERT_FILE").map(String::as_str);
        self.ca_bundle_path = [
            nix,
            Some("/etc/ssl/certs/ca-bundle.crt"),
            Some("/etc/ssl/certs/ca-certificates.crt"),
            Some("/etc/pki/tls/certs/ca-bundle.crt"),
            Some("/etc/ssl/cert.pem"),
        ]
        .into_iter()
        .flatten()
        .map(Path::new)
        .find(|candidate| candidate.is_absolute() && candidate.exists())
        .map(Path::to_path_buf);
        self
    }

    /// v1 `prepareAntigravityProfile` (:471-495): the private directories (0700) and `settings.json`.
    pub fn prepare(&self, auth: &AntigravityAuthConfig) -> Result<(), &'static str> {
        for directory in [&self.gemini_home, &self.acp_directory, &self.temp_directory] {
            std::fs::create_dir_all(directory)
                .map_err(|_| "The Antigravity profile directory could not be created.")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                    .map_err(
                        |_| "The Antigravity profile directory permissions could not be set.",
                    )?;
            }
        }
        std::fs::write(
            self.acp_directory.join("settings.json"),
            auth.profile_settings(),
        )
        .map_err(|_| "The Antigravity profile settings could not be written.")
    }
}

/// v1 `removedEnvironmentKeys` (:65-86): inherited variables that would pick another credential,
/// profile or browser.
pub const REMOVED_ENVIRONMENT_KEYS: [&str; 19] = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "AGY_ACP_CCPA_PROJECT",
    "AGY_ACP_ENABLE_OAUTH",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "AGY_CLI_DISABLE_AUTO_UPDATE",
    "ANTIGRAVITY_HARNESS_PATH",
    "BROWSER",
    "PYTHONUNBUFFERED",
    "ELECTRON_RUN_AS_NODE",
    "CHROME_CRASHPAD_PIPE_NAME",
];

/// The agent's environment: inherited names to drop and variables to set on top.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AntigravityEnvironment {
    pub remove: Vec<String>,
    pub set: Vec<(String, String)>,
}

/// v1 `antigravityEnvironment` (:206-248). `base_env` is the inherited environment; the credential
/// goes in the environment only for the API-key methods (the GCP pair stays in `settings.json`).
pub fn antigravity_environment(
    profile: &AntigravityProfile,
    base_env: &HashMap<String, String>,
    auth: &AntigravityAuthConfig,
    runtime_temp_directory: Option<&Path>,
) -> AntigravityEnvironment {
    let mut remove: Vec<String> = REMOVED_ENVIRONMENT_KEYS
        .iter()
        .map(|k| (*k).to_owned())
        .collect();
    // Windows treats keys case-insensitively: drop the inherited aliases too.
    for key in base_env.keys() {
        if REMOVED_ENVIRONMENT_KEYS.contains(&key.to_uppercase().as_str()) && !remove.contains(key)
        {
            remove.push(key.clone());
        }
    }
    let mut set = Vec::new();
    match auth.auth_method {
        AntigravityAuthMethod::GeminiApiKey if !auth.api_key.is_empty() => {
            set.push(("GEMINI_API_KEY".to_owned(), auth.api_key.clone()));
        }
        AntigravityAuthMethod::AgentPlatform if !auth.api_key.is_empty() => {
            set.push(("GOOGLE_API_KEY".to_owned(), auth.api_key.clone()));
        }
        _ => {}
    }
    if let Some(ca) = &profile.ca_bundle_path
        && !base_env.contains_key("SSL_CERT_FILE")
        && !base_env.contains_key("SSL_CERT_DIR")
    {
        set.push(("SSL_CERT_FILE".to_owned(), ca.display().to_string()));
    }
    set.push((
        "GEMINI_HOME".to_owned(),
        profile.gemini_home.display().to_string(),
    ));
    if auth.auth_method == AntigravityAuthMethod::OauthPersonal {
        let ssh = base_env
            .get("SSH_CONNECTION")
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| "127.0.0.1 0 127.0.0.1 0".to_owned());
        set.push(("SSH_CONNECTION".to_owned(), ssh));
    }
    set.push(("AGY_ACP_FORCE_FILE_STORAGE".to_owned(), "1".to_owned()));
    set.push(("AGY_CLI_DISABLE_AUTO_UPDATE".to_owned(), "true".to_owned()));
    set.push(("BROWSER".to_owned(), profile.browser_command.clone()));
    set.push(("PYTHONUNBUFFERED".to_owned(), "1".to_owned()));
    set.push(("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned()));
    let temp = runtime_temp_directory
        .unwrap_or(&profile.temp_directory)
        .display()
        .to_string();
    if profile.windows {
        set.push(("TEMP".to_owned(), temp.clone()));
        set.push(("TMP".to_owned(), temp));
    } else {
        set.push(("TMPDIR".to_owned(), temp));
    }
    AntigravityEnvironment { remove, set }
}

/// v1 `buildAntigravityAcpSpawnInput` arguments (:524-539): the `agy` CLI serves ACP through
/// `acp` with the private profile; the managed `agy_acp_server` takes its harness by environment
/// and logs to stderr, which carries the harness failure signal.
pub fn spawn_args(harness_path: Option<&Path>, profile: &AntigravityProfile) -> Vec<String> {
    match harness_path {
        None => vec![
            "acp".to_owned(),
            "--gemini-dir".to_owned(),
            profile.gemini_home.display().to_string(),
            "--app-data-dir".to_owned(),
            // The CLI joins this beneath gemini-dir, including when the value is absolute.
            "antigravity-acp".to_owned(),
        ],
        Some(_) => {
            let mut args = Vec::new();
            if profile.linux {
                args.push("--uid=".to_owned());
            }
            args.push("--alsologtostderr".to_owned());
            args
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOOPBACK: &str = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F";

    #[test]
    fn sign_in_url_must_be_googles_loopback_page() {
        assert_eq!(
            stdout_line(&format!("{ANTIGRAVITY_AUTH_STDOUT_PREFIX}{LOOPBACK}")),
            StdoutLine::AuthUrl(LOOPBACK.into())
        );
        for bad in [
            LOOPBACK.replace("accounts.google.com", "evil.example"),
            LOOPBACK.replace("state=abc", "state=abc&state=def"),
            LOOPBACK.replace("43123", "80"),
            LOOPBACK.replace("response_type=code", "response_type=token"),
            format!("{LOOPBACK}#frag"),
        ] {
            assert_eq!(
                stdout_line(&format!("{ANTIGRAVITY_AUTH_STDOUT_PREFIX}{bad}")),
                StdoutLine::Fail(ANTIGRAVITY_INVALID_SIGN_IN_URL.into()),
                "{bad}"
            );
        }
        assert_eq!(stdout_line("{\"jsonrpc\":\"2.0\"}"), StdoutLine::Json);
    }

    #[test]
    fn stderr_reports_links_and_harness_failures() {
        assert_eq!(
            stderr_line(&format!(
                "{ANTIGRAVITY_AUTH_BROWSER_MARKER}\"{LOOPBACK}\"\r"
            )),
            StderrLine::AuthUrl(LOOPBACK.into())
        );
        assert_eq!(
            stderr_line(&format!(
                "{ANTIGRAVITY_AUTH_STDOUT_PREFIX}https://evil.example/"
            )),
            StderrLine::Ignore
        );
        assert_eq!(
            stderr_line(
                "I1022 11:04:37.910207 1865358 local_connection.py:551] harness stderr: Agent run failed: failed to handle call hook response"
            ),
            StderrLine::Fail(ANTIGRAVITY_HARNESS_FAILURE_MESSAGE.into())
        );
        assert_eq!(
            stderr_line("E1022 11:04:37.9 42 server.py:10] Agent connection lost for session s1"),
            StderrLine::Fail(ANTIGRAVITY_HARNESS_FAILURE_MESSAGE.into())
        );
        assert_eq!(stderr_line("I1022 ordinary log"), StderrLine::Ignore);
    }

    #[test]
    fn login_code_or_callback_page() {
        let code_url = "https://accounts.google.com/o/oauth2/auth?response_type=code&state=s1&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback";
        let pending = parse_authorization_url(code_url, AuthorizationUrlKind::Code).unwrap();
        assert_eq!(
            login_response(&pending, " 4/abc-DEF "),
            Some("4/abc-DEF".into())
        );
        assert_eq!(
            login_response(
                &pending,
                "https://antigravity.google/oauth-callback?state=s1&code=c"
            )
            .as_deref(),
            Some("https://antigravity.google/oauth-callback?state=s1&code=c")
        );
        assert_eq!(
            login_response(
                &pending,
                "https://antigravity.google/oauth-callback?state=other&code=c"
            ),
            None
        );
        assert_eq!(login_response(&pending, "a\nb"), None);
    }

    /// v1 antigravityAuthSupport.ts:401-420: on Linux the first existing absolute CA candidate is
    /// the bundle, NIX_SSL_CERT_FILE first; elsewhere none (round 7 part 5a.7).
    #[test]
    fn linux_profiles_find_a_ca_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("nix-ca.pem");
        std::fs::write(&bundle, "cert").unwrap();
        let env: HashMap<String, String> =
            [("NIX_SSL_CERT_FILE".to_owned(), bundle.display().to_string())].into();
        let mut profile = AntigravityProfile::new(Path::new("/p"), String::new());
        profile.linux = true;
        let linux = profile.clone().with_linux_ca_bundle(&env);
        assert_eq!(linux.ca_bundle_path.as_deref(), Some(bundle.as_path()));
        let relative: HashMap<String, String> =
            [("NIX_SSL_CERT_FILE".to_owned(), "nix-ca.pem".to_owned())].into();
        assert_ne!(
            profile
                .clone()
                .with_linux_ca_bundle(&relative)
                .ca_bundle_path,
            Some(PathBuf::from("nix-ca.pem"))
        );
        profile.linux = false;
        assert_eq!(profile.with_linux_ca_bundle(&env).ca_bundle_path, None);
    }

    #[test]
    fn sign_in_errors_and_config_issues() {
        assert!(is_sign_in_required(-32000, "Authentication required"));
        assert!(is_sign_in_required(
            -32603,
            "No browser is available here. Run agy acp --login"
        ));
        assert!(!is_sign_in_required(-32603, "Internal error"));
        let mut auth = AntigravityAuthConfig {
            auth_method: AntigravityAuthMethod::GeminiApiKey,
            ..Default::default()
        };
        assert_eq!(
            auth.issue(),
            Some("Enter a Gemini API key in the Antigravity provider settings.")
        );
        // A distinctive key, so the Debug check below proves it is left out (round 7 part 5a.5).
        auth.api_key = "AIzaSy-distinctive-test-key-4242".into();
        assert_eq!(auth.issue(), None);
        let debug = format!("{auth:?}");
        assert!(!debug.contains("distinctive-test-key"), "{debug}");
        assert!(debug.contains("<set>"), "{debug}");
        let business = AntigravityAuthConfig {
            auth_method: AntigravityAuthMethod::OauthBusiness,
            gcp_project: "p".into(),
            gcp_location: "l".into(),
            ..Default::default()
        };
        assert_eq!(
            business.profile_settings(),
            "{\"auth\":{\"type\":\"oauth-business\"},\"gcp\":{\"project\":\"p\",\"location\":\"l\"}}\n"
        );
    }

    #[test]
    fn environment_isolates_credentials_and_profile() {
        let mut profile = AntigravityProfile::new(Path::new("/p"), "'node' '-e'".into());
        profile.windows = false;
        let base: HashMap<String, String> = [
            ("GOOGLE_API_KEY".to_owned(), "leak".to_owned()),
            ("Gemini_Home".to_owned(), "/x".to_owned()),
        ]
        .into();
        let auth = AntigravityAuthConfig {
            auth_method: AntigravityAuthMethod::GeminiApiKey,
            api_key: "secret".into(),
            ..Default::default()
        };
        let env = antigravity_environment(&profile, &base, &auth, Some(Path::new("/t")));
        assert!(env.remove.contains(&"GOOGLE_API_KEY".to_owned()));
        assert!(env.remove.contains(&"Gemini_Home".to_owned()));
        let set: HashMap<_, _> = env.set.into_iter().collect();
        assert_eq!(set["GEMINI_API_KEY"], "secret");
        assert_eq!(set["GEMINI_HOME"], "/p");
        assert_eq!(set["TMPDIR"], "/t");
        assert_eq!(set["AGY_CLI_DISABLE_AUTO_UPDATE"], "true");
        assert!(!set.contains_key("SSH_CONNECTION"));
        assert_eq!(
            spawn_args(None, &profile),
            [
                "acp",
                "--gemini-dir",
                "/p",
                "--app-data-dir",
                "antigravity-acp"
            ]
        );
        let dirs = instance_directories(Path::new("/s"), "antigravity");
        assert!(dirs.profile.starts_with("/s/providers/antigravity"));
        assert_eq!(dirs.runtime_temp.file_name().unwrap().len(), 12);
        assert!(browser_command("/opt/a:b/node", false).is_err());
        assert!(browser_command("C:\\x;y\\node.exe", true).is_err());
        assert!(
            browser_command("node", false)
                .unwrap()
                .starts_with("'node' '-e' ")
        );
    }
}
