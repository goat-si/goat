//! ACP driver wiring: Grok, fx and Antigravity, plus the ACP registry catalog.
//!
//! `goat2-engine-acp` (lane P2-B) owns the drivers. The host supplies what they cannot see: the
//! programs (`GOAT2_GROK_BIN`, `GOAT2_FX_BIN`, `GOAT2_ANTIGRAVITY_BIN`), GOAT 2's own Antigravity
//! profile under the data dir, an attachment's saved file in the thread folder and GOAT's stdio MCP
//! bridge (`goat2-acp-mcp-bridge` beside the `goat2-host` executable, where lane G bundles it in
//! `Contents/Resources/bin`, or `GOAT2_ACP_MCP_BRIDGE`; found by the driver's
//! `McpBridgeCommand::locate` when a factory is built). Registry agents (v1 driver `acpRegistry`) are
//! built per agent through [registry_agent_factory] once a provider target names its agent.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use goat2_engine_acp::agents::antigravity::{
    Antigravity, AntigravityInstallation, AntigravityLaunch, RUNTIME_PROGRAM,
};
use goat2_engine_acp::agents::antigravity_auth::{
    AntigravityAuthConfig, AntigravityProfile, browser_command, instance_directories,
};
use goat2_engine_acp::agents::fx::Fx;
use goat2_engine_acp::agents::grok::Grok;
use goat2_engine_acp::probe::ProbeConfig;
use goat2_engine_acp::probe::antigravity::resolve_antigravity_executable;
use goat2_engine_acp::probe::support::resolve_executable;
use goat2_engine_acp::registry::index::cache::HttpsFetch;
use goat2_engine_acp::registry::runtime_temp::RuntimeTempLease;
use goat2_engine_acp::registry::{
    AcpRegistryCatalog, CatalogOptions, HostContext, HttpsDownload, RegistryError, RegistrySettings,
};
use goat2_engine_acp::{AcpEngineFactory, AcpFlavor, AttachmentResolver};
use goat2_engine_api::LaunchSpec;

/// v1 ProviderDriverKind slugs, as each flavor names its driver.
pub const GROK: &str = "grok";
pub const FX: &str = "fx";
pub const ANTIGRAVITY: &str = "antigravity";

/// The three ACP drivers GOAT 2 registers beside Codex and Claude, keyed by driver kind.
pub fn acp_factories(
    data_dir: &Path,
    grok_bin: Option<&Path>,
    fx_bin: Option<&Path>,
    antigravity_bin: Option<&Path>,
) -> Vec<(String, AcpEngineFactory)> {
    [
        grok_factory(data_dir, grok_bin),
        fx_factory(data_dir, fx_bin),
        antigravity_factory(data_dir, antigravity_bin),
    ]
    .into_iter()
    .map(|factory| (factory.flavor().driver().to_owned(), factory))
    .collect()
}

/// Grok: `grok` on PATH unless `GOAT2_GROK_BIN` names the program (v1 `GrokSettings.binaryPath`).
/// Grok keeps its own login (`GROK_HOME`); v1 has no GOAT-owned Grok home.
pub fn grok_factory(data_dir: &Path, grok_bin: Option<&Path>) -> AcpEngineFactory {
    let flavor = Grok {
        binary_path: grok_bin.map(Path::to_path_buf),
        ..Grok::default()
    };
    host_factory(data_dir, Arc::new(flavor), ProbeConfig::default())
}

/// fx: `fx` on PATH unless `GOAT2_FX_BIN` names the program (v1 `FxSettings.binaryPath`). Every
/// instance shares fx's own login, as in v1.
pub fn fx_factory(data_dir: &Path, fx_bin: Option<&Path>) -> AcpEngineFactory {
    let flavor = Fx {
        binary_path: fx_bin.map(|bin| bin.to_string_lossy().into_owned()),
        ..Fx::default()
    };
    host_factory(data_dir, Arc::new(flavor), ProbeConfig::default())
}

/// GOAT 2's Antigravity profile for the default instance: v1's per-instance layout
/// (`<dataDir>/providers/antigravity/<sha256(instanceId)>`, mode 0700), so GOAT 2 never signs in
/// with or writes the person's own `~/.gemini`. A second instance's profile lives in its own home
/// (`ProviderTarget.home`; the driver's `with_home`).
pub fn antigravity_profile(data_dir: &Path) -> PathBuf {
    instance_directories(data_dir, ANTIGRAVITY).profile
}

/// Antigravity: the runtime resolved as the driver's own probe resolves it (`GOAT2_ANTIGRAVITY_BIN`,
/// else the ACP runtime and then `agy` on the host's PATH; v1 `AntigravityInstallation.resolve`
/// without managed releases), signed in with a Google account (v1's default method) through
/// GOAT 2's own profile. When nothing resolves at host start the probe reports why, and a session
/// tries `agy` (or the configured program) with the same profile; it never runs without it.
pub fn antigravity_factory(data_dir: &Path, antigravity_bin: Option<&Path>) -> AcpEngineFactory {
    let dirs = instance_directories(data_dir, ANTIGRAVITY);
    let auth = AntigravityAuthConfig::default();
    let env = host_environment();
    let executable =
        match resolve_antigravity_executable(antigravity_bin, Path::new(RUNTIME_PROGRAM), &env) {
            Ok(executable) => executable,
            Err(detail) => {
                // The detail is one of the driver's fixed messages: no path.
                tracing::info!(detail, "Antigravity runtime not resolved at host start");
                antigravity_bin.map_or_else(|| PathBuf::from("agy"), Path::to_path_buf)
            }
        };
    let profile = AntigravityProfile::new(&dirs.profile, sign_in_browser_command(&env));
    private_dir(&dirs.profile);
    private_dir(&dirs.runtime_temp);
    if let Err(message) = profile.prepare(&auth) {
        // A fixed message: the profile path stays out of the log.
        tracing::warn!(message, "Antigravity profile not prepared");
    }
    let flavor = Antigravity {
        auth,
        launch: Some(AntigravityLaunch {
            installation: AntigravityInstallation::external(executable),
            profile,
            runtime_temp_directory: Some(dirs.runtime_temp),
            base_env: None,
        }),
        ..Antigravity::default()
    };
    // The probe checks the configured program itself, so a wrong `GOAT2_ANTIGRAVITY_BIN` shows
    // v1's custom-executable message.
    let probe = ProbeConfig {
        launch: antigravity_bin.map(|bin| LaunchSpec {
            binary: Some(bin.to_path_buf()),
            ..LaunchSpec::default()
        }),
        ..ProbeConfig::default()
    };
    host_factory(data_dir, Arc::new(flavor), probe)
}

/// The ACP registry catalog (index cache, managed installs) under the data dir, v1's layout
/// (`caches`, `tools`, `userdata/antigravity-tmp/acp-registry`), on HTTPS transports.
pub type RegistryCatalog = AcpRegistryCatalog<HttpsFetch>;

pub fn registry_catalog(data_dir: &Path) -> Result<RegistryCatalog, String> {
    Ok(AcpRegistryCatalog::new(
        CatalogOptions::under(data_dir),
        HttpsFetch::new()?,
        Arc::new(HttpsDownload::new()?),
        HostContext::current(),
    ))
}

/// v1 settings for a registry agent named by `acpAgentId` (every other field at v1's default).
pub fn registry_agent_settings(agent_id: &str) -> RegistrySettings {
    RegistrySettings {
        agent_id: agent_id.to_owned(),
        ..RegistrySettings::default()
    }
}

/// One registry agent's factory and the runtime temp folder it owns while it is in use.
pub struct RegistryAgentFactory {
    pub factory: AcpEngineFactory,
    /// Released when dropped; keep it as long as the factory starts sessions.
    pub runtime_temp: Option<RuntimeTempLease>,
}

/// A factory for the registry agent `settings` names, resolved through `catalog` (v1 registry
/// adapter: index lookup, install when `allow_install`, command path, session environment), with
/// the host's attachment lookup and the MCP bridge, and the settings as its probe settings. The
/// providers module calls this once a provider target carries the instance's agent id.
pub async fn registry_agent_factory(
    catalog: &RegistryCatalog,
    data_dir: &Path,
    settings: &RegistrySettings,
    cwd: &Path,
    allow_install: bool,
) -> Result<RegistryAgentFactory, RegistryError> {
    let launch = catalog.launch(settings, cwd, None, allow_install).await?;
    let probe = ProbeConfig {
        registry: Some(settings.clone()),
        registry_version: launch.resolved.agent.as_ref().map(|a| a.version.clone()),
        ..ProbeConfig::default()
    };
    Ok(RegistryAgentFactory {
        factory: host_factory(data_dir, Arc::new(launch.flavor), probe),
        runtime_temp: launch.runtime_temp,
    })
}

/// Every ACP factory the host builds: the flavor, its probe settings and the attachment lookup
/// (only saved `blobs/<name>` files of the thread). `AcpEngineFactory::new` locates the MCP bridge.
fn host_factory(
    data_dir: &Path,
    flavor: Arc<dyn AcpFlavor>,
    probe: ProbeConfig,
) -> AcpEngineFactory {
    AcpEngineFactory::new(flavor)
        .with_attachment_resolver(attachment_resolver(data_dir))
        .with_probe_config(probe)
}

fn attachment_resolver(data_dir: &Path) -> AttachmentResolver {
    let threads = data_dir.join("threads");
    Arc::new(move |thread_id, attachment| {
        super::codex::attachment_path(&threads, thread_id, attachment)
    })
}

/// The host's environment as the driver's lookups read it (names and values that are UTF-8).
fn host_environment() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// v1 suppresses Antigravity's browser during sign-in with a Node helper that prints the URL for
/// GOAT (antigravityAuthSupport.ts:382-396, there Electron-as-Node). GOAT 2's host is not Node:
/// `node` on the host's PATH runs the helper. Without it the variable is empty and the runtime opens
/// the sign-in page in the system browser itself.
fn sign_in_browser_command(env: &BTreeMap<String, String>) -> String {
    resolve_executable(Path::new("node"), None, env)
        .and_then(|node| browser_command(&node.to_string_lossy(), cfg!(windows)).ok())
        .unwrap_or_default()
}

/// Created private before a runtime writes credentials into it; a failure only loses the mode
/// here (the profile preparation reports a folder it cannot create).
fn private_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let _ = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir);
    }
    #[cfg(not(unix))]
    let _ = std::fs::create_dir_all(dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    use goat2_contracts::{BlobRef, ChatAttachment, ChatAttachmentType, ThreadId};
    use goat2_engine_api::EngineFactory;

    fn attachment(path: &str) -> ChatAttachment {
        ChatAttachment {
            kind: ChatAttachmentType::Image,
            id: "a".into(),
            name: "a.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 1,
            blob: Some(BlobRef {
                path: path.into(),
                size_bytes: 1,
            }),
        }
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn antigravity_runs_in_goat2s_own_profile() {
        let dir = tempfile::tempdir().unwrap();
        let factory = antigravity_factory(dir.path(), Some(Path::new("/goat2-no/agy")));
        let profile = antigravity_profile(dir.path());
        assert!(profile.starts_with(dir.path().join("providers/antigravity")));
        let settings = std::fs::read_to_string(profile.join("antigravity-acp/settings.json"))
            .expect("the profile names the sign-in method");
        assert!(settings.contains("oauth-personal"), "{settings}");
        #[cfg(unix)]
        assert_eq!(mode(&profile), 0o700);
        // The configured program reaches the probe as the instance's binary.
        assert_eq!(
            factory
                .probe_config()
                .launch
                .as_ref()
                .and_then(|l| l.binary.clone()),
            Some(PathBuf::from("/goat2-no/agy"))
        );
        assert!(
            antigravity_factory(dir.path(), None)
                .probe_config()
                .launch
                .is_none()
        );
    }

    #[tokio::test]
    async fn the_configured_programs_reach_the_probes() {
        let dir = tempfile::tempdir().unwrap();
        let missing = |driver: &str| PathBuf::from(format!("/goat2-no/{driver}"));
        for (driver, factory) in acp_factories(
            dir.path(),
            Some(&missing(GROK)),
            Some(&missing(FX)),
            Some(&missing("agy")),
        ) {
            let result = factory.probe().await.unwrap();
            assert!(!result.installed, "{driver}: {result:?}");
        }
    }

    #[test]
    fn attachments_resolve_only_to_saved_blobs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("threads/t1/blobs")).unwrap();
        std::fs::write(dir.path().join("threads/t1/blobs/a.png"), b"png").unwrap();
        let resolve = attachment_resolver(dir.path());
        let t1 = ThreadId::new("t1");
        assert_eq!(
            resolve(&t1, &attachment("blobs/a.png")),
            Some(dir.path().join("threads/t1/blobs/a.png"))
        );
        assert_eq!(resolve(&t1, &attachment("../secret")), None);
    }

    /// A local registry agent resolves through the catalog without the network.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_registry_agent_factory_is_built_from_the_catalog() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("my-agent");
        std::fs::write(&agent, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
        let catalog = registry_catalog(dir.path()).unwrap();
        let settings = RegistrySettings {
            source: goat2_engine_acp::registry::settings::Source::Local,
            command_path: agent.to_string_lossy().into_owned(),
            ..RegistrySettings::default()
        };
        let built = registry_agent_factory(&catalog, dir.path(), &settings, dir.path(), false)
            .await
            .unwrap();
        assert_eq!(built.factory.flavor().driver(), "acpRegistry");
        assert_eq!(
            built.factory.capabilities(),
            built.factory.flavor().capabilities()
        );
        assert_eq!(
            built.factory.probe_config().registry.as_ref(),
            Some(&settings)
        );
        assert_eq!(registry_agent_settings("devin").agent_id, "devin");
    }
}
