//! Catalog tests ported from v1 `AcpRegistrySupport.test.ts`, `.binaryInstall.test.ts`,
//! `.noInstall.test.ts` and `.npmShim.test.ts` with the `AcpRegistrySupport.testkit.ts` setup:
//! platform `linux`/`x64`, the fake npm and uv scripts from v1 (`testing/*.fixture.sh`, verbatim) on
//! a temp PATH, and a 127.0.0.1 HTTP server standing in for `https://registry.test`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::archive::tests::{tar_gz, zip_bytes};
use super::catalog::{
    AcpRegistryCatalog, CatalogOptions, HostContext, Inspection, LaunchKind, ResolveOptions,
    SpawnSpec, launch_command,
};
use super::command_path::Environment;
use super::contracts::{
    AcpRegistryDistribution, AcpRegistryOperationErrorReason as Reason, AcpRegistryPrepareInput,
    AcpRegistrySearchInput,
};
use super::index::cache::RegistryFetch;
use super::install::{ArchiveDownload, ByteStream, http_stream};
use super::local_presets::LocalPreset;
use super::settings::{RegistrySettings, Source};

const REGISTRY_URL: &str = "https://registry.test/registry.json";
const NPM_FIXTURE: &str = include_str!("testing/npm.fixture.sh");
const UV_FIXTURE: &str = include_str!("testing/uv.fixture.sh");

type Routes = Arc<Mutex<HashMap<String, (u16, Vec<u8>)>>>;

/// A one-request-per-connection HTTP/1.1 server on 127.0.0.1 with mutable routes.
#[derive(Clone)]
struct Server {
    origin: String,
    routes: Routes,
    requests: Arc<Mutex<Vec<String>>>,
}

impl Server {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = Self {
            origin: format!("http://{}", listener.local_addr().unwrap()),
            routes: Arc::default(),
            requests: Arc::default(),
        };
        let state = server.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let state = state.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                            return;
                        }
                        head.push(byte[0]);
                    }
                    let head = String::from_utf8_lossy(&head);
                    let path = head.split(' ').nth(1).unwrap_or("/").to_owned();
                    state.requests.lock().unwrap().push(path.clone());
                    let (status, body) = state
                        .routes
                        .lock()
                        .unwrap()
                        .get(&path)
                        .cloned()
                        .unwrap_or((404, b"missing".to_vec()));
                    let header = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(header.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        server
    }
    fn route(&self, path: &str, status: u16, body: impl Into<Vec<u8>>) {
        self.routes
            .lock()
            .unwrap()
            .insert(path.into(), (status, body.into()));
    }
    fn registry(&self, document: &str) {
        self.route("/registry.json", 200, document);
    }
    fn count(&self, path: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|p| *p == path)
            .count()
    }
    fn transport(&self) -> Rewrite {
        Rewrite {
            origin: self.origin.clone(),
            client: reqwest::Client::new(),
        }
    }
}

/// Maps `https://registry.test` onto the local server; the catalog still sees HTTPS URLs.
#[derive(Clone)]
struct Rewrite {
    origin: String,
    client: reqwest::Client,
}
impl Rewrite {
    fn map(&self, url: &str) -> String {
        url.replacen("https://registry.test", &self.origin, 1)
    }
}
#[async_trait]
impl RegistryFetch for Rewrite {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        let response = self
            .client
            .get(self.map(url))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?;
        Ok(response.bytes().await.map_err(|e| e.to_string())?.to_vec())
    }
}
#[async_trait]
impl ArchiveDownload for Rewrite {
    async fn open(&self, url: &str) -> Result<ByteStream, String> {
        http_stream(&self.client, &self.map(url)).await
    }
}

fn agent(id: &str, version: &str, distribution: Value) -> Value {
    json!({"id": id, "name": "Example Agent", "version": version,
           "description": "ACP Registry test agent", "distribution": distribution})
}
fn registry(agents: &[Value]) -> String {
    json!({"version": "1.0.0", "agents": agents}).to_string()
}
fn example(distribution: Value) -> String {
    registry(&[agent("example-agent", "1.2.3", distribution)])
}
fn settings() -> RegistrySettings {
    RegistrySettings {
        agent_id: "example-agent".into(),
        ..RegistrySettings::default()
    }
}
fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn base_env() -> Environment {
    [("PATH".to_owned(), "/usr/bin:/bin".to_owned())].into()
}
fn with_path(env: &Environment, first: &Path) -> Environment {
    let mut env = env.clone();
    let rest = env.get("PATH").cloned().unwrap_or_default();
    env.insert("PATH".into(), format!("{}:{rest}", first.display()));
    env
}
fn executable(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn catalog_with(
    dir: &Path,
    server: &Server,
    env: Environment,
    platform: &str,
) -> AcpRegistryCatalog<Rewrite> {
    AcpRegistryCatalog::new(
        CatalogOptions {
            cache_dir: dir.to_path_buf(),
            tools_dir: dir.join("tools"),
            registry_url: Some(REGISTRY_URL.into()),
            runtime_temp_dir: Some(dir.join("runtime-tmp").join("acp-registry")),
        },
        server.transport(),
        Arc::new(server.transport()),
        HostContext {
            platform: platform.into(),
            architecture: "x64".into(),
            environment: env,
        },
    )
}
fn catalog(dir: &Path, server: &Server, env: Environment) -> AcpRegistryCatalog<Rewrite> {
    catalog_with(dir, server, env, "linux")
}

/// v1 `AcpRegistrySupport.testkit.ts:59-104` `makeFakeNpmToolchain`.
struct Toolchain {
    environment: Environment,
    executable_path: PathBuf,
    global_bin: PathBuf,
    log_path: PathBuf,
}
fn fake_npm(root: &Path) -> Toolchain {
    let toolchain_bin = root.join("fake-node/bin");
    let global_prefix = root.join("tools/example-agent/1.2.3/npm");
    let global_bin = global_prefix.join("bin");
    std::fs::create_dir_all(&global_prefix).unwrap();
    let log_path = root.join("npm.log");
    std::fs::write(&log_path, "").unwrap();
    executable(&toolchain_bin.join("npm"), NPM_FIXTURE);
    let mut environment = with_path(&base_env(), &toolchain_bin);
    environment.insert("FAKE_NPM_LOG".into(), log_path.display().to_string());
    environment.insert(
        "FAKE_NPM_PREFIX".into(),
        root.join("external-npm-global").display().to_string(),
    );
    environment.insert(
        "FAKE_NPM_MANIFEST".into(),
        json!({"name": "@example/acp", "version": "1.2.3", "bin": {"example-agent": "dist/cli.js"}}).to_string(),
    );
    Toolchain {
        environment,
        executable_path: global_bin.join("example-agent"),
        global_bin,
        log_path,
    }
}
/// v1 `AcpRegistrySupport.testkit.ts:106-134` `makeFakeUvToolchain`.
fn fake_uv(root: &Path) -> Toolchain {
    let toolchain_bin = root.join("fake-uv/bin");
    let global_bin = root.join("tools/example-agent/1.2.3/python/bin");
    let log_path = root.join("uv.log");
    std::fs::write(&log_path, "").unwrap();
    executable(&toolchain_bin.join("uv"), UV_FIXTURE);
    let mut environment = with_path(&base_env(), &toolchain_bin);
    environment.insert("FAKE_UV_LOG".into(), log_path.display().to_string());
    environment.insert(
        "FAKE_UV_BIN".into(),
        root.join("external-uv-bin").display().to_string(),
    );
    Toolchain {
        environment,
        executable_path: global_bin.join("fast-agent"),
        global_bin,
        log_path,
    }
}
fn log(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}
fn write_cached_registry(dir: &Path, document: &str) {
    std::fs::create_dir_all(dir.join("acp-registry")).unwrap();
    std::fs::write(dir.join("acp-registry/registry.json"), document).unwrap();
}
fn prepare_input() -> AcpRegistryPrepareInput {
    AcpRegistryPrepareInput {
        agent_id: "example-agent".into(),
    }
}
fn leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir.join("tools/example-agent/1.2.3"))
        .map(|it| {
            it.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

// ---- binary installs over HTTP ----

#[tokio::test]
async fn installs_a_verified_tar_gz_binary_over_http_and_reuses_it() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let archive = tar_gz(&[("bin/example-agent", b"#!/bin/sh\necho example\n", 0o644)]);
    server.route("/agent.tar.gz", 200, archive.clone());
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.tar.gz", "cmd": "./bin/example-agent",
        "sha256": sha256(&archive).to_uppercase(), "args": ["acp"], "env": {"AGENT_MODE": "acp"}}}})));
    let c = catalog(dir.path(), &server, base_env());

    let prepared = c.prepare(&prepare_input()).await.unwrap();
    assert_eq!(prepared.distribution, AcpRegistryDistribution::Binary);
    assert_eq!(prepared.version, "1.2.3");
    let resolved = c
        .resolve(
            &settings(),
            Path::new("/workspace"),
            None,
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    let installed = std::fs::canonicalize(
        dir.path()
            .join("tools/example-agent/1.2.3/linux-x86_64/bin/example-agent"),
    )
    .unwrap();
    assert_eq!(resolved.spawn.command, installed);
    assert_eq!(resolved.spawn.args, ["acp"]);
    assert_eq!(resolved.spawn.env["AGENT_MODE"], "acp");
    assert_eq!(resolved.spawn.cwd, Path::new("/workspace"));
    assert_eq!(resolved.distribution, LaunchKind::Binary);
    // The download's archive mode was 0644; the command is made executable.
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
        0o755
    );
    c.resolve(
        &settings(),
        Path::new("/workspace"),
        None,
        &ResolveOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(server.count("/agent.tar.gz"), 1);
    assert_eq!(leftovers(dir.path()), ["linux-x86_64"]);
    let inspection = c.inspect(&settings(), None).await.unwrap();
    assert!(matches!(
        inspection,
        Inspection::Ready {
            distribution: LaunchKind::Binary,
            ..
        }
    ));
    assert_eq!(
        c.managed_binary_directories(),
        [dir.path()
            .join("tools/example-agent/1.2.3/linux-x86_64/bin")]
    );
}

#[tokio::test]
async fn installs_a_zip_binary() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.route(
        "/agent.zip",
        200,
        zip_bytes(&[("dist/agent", b"#!/bin/sh\n", 0o755)]),
    );
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.zip", "cmd": "dist/agent"}}})));
    let c = catalog(dir.path(), &server, base_env());
    let resolved = c
        .resolve(
            &settings(),
            Path::new("/w"),
            None,
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert!(resolved.spawn.command.ends_with("linux-x86_64/dist/agent"));
}

// v1 AcpRegistrySupport.test.ts:909-950.
#[tokio::test]
async fn rejects_a_download_that_does_not_match_its_sha256() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.route(
        "/agent.tar.gz",
        200,
        tar_gz(&[("agent", b"#!/bin/sh\n", 0o755)]),
    );
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.tar.gz", "cmd": "agent", "sha256": "0".repeat(64)}}})));
    let c = catalog(dir.path(), &server, base_env());
    let error = c.prepare(&prepare_input()).await.unwrap_err();
    assert_eq!(error.reason, Reason::ChecksumMismatch);
    assert_eq!(
        error.detail,
        "ACP Registry agent example-agent download did not match its declared SHA-256."
    );
    assert!(
        leftovers(dir.path()).is_empty(),
        "{:?}",
        leftovers(dir.path())
    );
}

#[tokio::test]
async fn rejects_an_archive_with_a_traversal_entry() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.route(
        "/agent.tar.gz",
        200,
        tar_gz(&[
            ("agent", b"#!/bin/sh\n", 0o755),
            ("../../escape", b"x", 0o644),
        ]),
    );
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.tar.gz", "cmd": "agent"}}})));
    let c = catalog(dir.path(), &server, base_env());
    let error = c.prepare(&prepare_input()).await.unwrap_err();
    assert_eq!(error.reason, Reason::ArchiveInvalid);
    assert_eq!(
        error.detail,
        "ACP Registry agent example-agent archive contains an unsafe path."
    );
    assert!(!dir.path().join("tools/escape").exists());
    assert!(!dir.path().join("tools/example-agent/escape").exists());
    assert!(leftovers(dir.path()).is_empty());
}

/// Final review 6 finding C1: an archive that would expand past the extraction limit is refused
/// as invalid and leaves nothing behind (v1 extracts it whole, AcpRegistrySupport.ts:1402-1416).
#[tokio::test]
async fn rejects_an_archive_that_expands_past_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.route(
        "/agent.tar.gz",
        200,
        super::archive::tests::tar_gz_declaring("agent", 4 * 1024 * 1024 * 1024 + 1, &[0; 4096]),
    );
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.tar.gz", "cmd": "agent"}}})));
    let c = catalog(dir.path(), &server, base_env());
    let error = c.prepare(&prepare_input()).await.unwrap_err();
    assert_eq!(error.reason, Reason::ArchiveInvalid, "{}", error.detail);
    assert_eq!(
        error.detail,
        "ACP Registry agent example-agent archive expands past 4 GiB or 200000 entries."
    );
    assert!(
        leftovers(dir.path()).is_empty(),
        "{:?}",
        leftovers(dir.path())
    );
}

// v1 AcpRegistrySupport.binaryInstall.test.ts:147-207.
#[tokio::test]
async fn leaves_an_outside_file_alone_when_the_command_links_to_it() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside");
    std::fs::write(&outside, "private\n").unwrap();
    std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    builder.append_link(&mut header, "agent", &outside).unwrap();
    let archive = builder.into_inner().unwrap().finish().unwrap();
    let server = Server::start().await;
    server.route("/agent.tar.gz", 200, archive);
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.tar.gz", "cmd": "./agent"}}})));
    let c = catalog(dir.path(), &server, base_env());
    let error = c.prepare(&prepare_input()).await.unwrap_err();
    assert_eq!(error.reason, Reason::ArchiveInvalid);
    assert_eq!(
        error.detail,
        "ACP Registry archive command resolves outside its installation directory."
    );
    assert_eq!(
        std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

// v1 AcpRegistrySupport.test.ts:990-1026.
#[tokio::test]
async fn rejects_unsafe_command_paths_before_downloading() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.bin", "cmd": "../agent"}}})));
    let c = catalog(dir.path(), &server, base_env());
    let error = c.prepare(&prepare_input()).await.unwrap_err();
    assert_eq!(error.reason, Reason::ArchiveInvalid);
    assert_eq!(
        error.detail,
        "ACP Registry agent example-agent declares an unsafe command path '../agent'."
    );
    assert_eq!(server.count("/agent.bin"), 0);
}

#[tokio::test]
async fn reports_download_failures_and_missing_commands() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/gone.bin", "cmd": "agent"}}})));
    let c = catalog(dir.path(), &server, base_env());
    let error = c.prepare(&prepare_input()).await.unwrap_err();
    assert_eq!(error.reason, Reason::DownloadFailed);
    assert_eq!(
        error.detail,
        "Could not download ACP Registry agent example-agent 1.2.3."
    );

    server.route("/agent.tar.gz", 200, tar_gz(&[("other", b"x", 0o755)]));
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.tar.gz", "cmd": "bin/agent"}}})));
    let error = c.prepare(&prepare_input()).await.unwrap_err();
    assert_eq!(error.reason, Reason::ArchiveInvalid);
    assert_eq!(
        error.detail,
        "ACP Registry archive for example-agent did not contain 'bin/agent'."
    );
    assert!(
        !dir.path()
            .join("tools/example-agent/1.2.3/linux-x86_64.lock")
            .exists()
    );
}

// v1 AcpRegistrySupport.binaryInstall.test.ts:25-80.
#[tokio::test]
async fn installs_the_current_version_when_a_cached_index_pins_a_removed_build() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let binary = |version: &str| {
        registry(&[agent(
            "example-agent",
            version,
            json!({"binary": {"linux-x86_64": {
            "archive": format!("https://registry.test/example-agent-{version}.bin"),
            "cmd": "./bin/example-agent", "args": ["acp"]}}}),
        )])
    };
    write_cached_registry(dir.path(), &binary("1.2.3"));
    server.registry(&binary("1.2.4"));
    server.route("/example-agent-1.2.3.bin", 403, "forbidden");
    server.route("/example-agent-1.2.4.bin", 200, "#!/bin/sh\necho example\n");
    let c = catalog(dir.path(), &server, base_env());
    let resolved = c
        .resolve(
            &settings(),
            Path::new("/workspace"),
            None,
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(resolved.agent.unwrap().version, "1.2.4");
    assert!(
        resolved
            .spawn
            .command
            .to_string_lossy()
            .contains("/tools/example-agent/1.2.4/")
    );
    assert_eq!(server.count("/registry.json"), 1);
}

// v1 AcpRegistrySupport.binaryInstall.test.ts:82-145.
#[tokio::test]
async fn keeps_a_prepared_binary_ready_after_the_registry_advances() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let publish = |version: &str| {
        server.registry(&registry(&[agent(
            "example-agent",
            version,
            json!({"binary": {"linux-x86_64": {
            "archive": format!("https://registry.test/example-agent-{version}.bin"),
            "cmd": "./bin/example-agent"}}}),
        )]));
        server.route(
            &format!("/example-agent-{version}.bin"),
            200,
            format!("#!/bin/sh\necho {version}\n"),
        );
    };
    publish("1.2.3");
    let c = catalog(dir.path(), &server, base_env());
    c.prepare(&prepare_input()).await.unwrap();
    publish("1.2.4");
    assert!(c.refresh_index(None, None).await.unwrap());
    assert!(matches!(
        c.inspect(&settings(), None).await.unwrap(),
        Inspection::Ready {
            distribution: LaunchKind::Binary,
            ..
        }
    ));
    let resolved = c
        .resolve(
            &settings(),
            Path::new("/workspace"),
            Some(&Environment::new()),
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert!(
        resolved
            .spawn
            .command
            .ends_with("tools/example-agent/1.2.4/linux-x86_64/bin/example-agent")
    );
    assert_eq!(
        std::fs::read_to_string(&resolved.spawn.command).unwrap(),
        "#!/bin/sh\necho 1.2.4\n"
    );
    let input = prepare_input();
    assert!(
        c.uninstall_managed_binary(&input, &[])
            .await
            .unwrap()
            .removed
    );
    assert!(matches!(
        c.inspect(&settings(), None).await.unwrap(),
        Inspection::Unprepared { .. }
    ));
    assert!(!dir.path().join("tools/example-agent").exists());
}

// v1 AcpRegistrySupport.test.ts:1297-1389,1460-1509.
#[tokio::test]
async fn keeps_reserved_or_referenced_binaries_on_uninstall() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.route("/agent.bin", 200, "#!/bin/sh\n");
    server.registry(&example(json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/agent.bin", "cmd": "agent"}}})));
    let c = catalog(dir.path(), &server, base_env());
    c.prepare(&prepare_input()).await.unwrap();
    let input = prepare_input();
    // Just prepared: another client is about to save it.
    assert!(
        !c.uninstall_managed_binary(&input, &[])
            .await
            .unwrap()
            .removed
    );
    // A configured instance still uses it (and inspection consumes the reservation).
    assert!(
        !c.uninstall_managed_binary(&input, &[settings()])
            .await
            .unwrap()
            .removed
    );
    let local = RegistrySettings {
        source: Source::Local,
        ..settings()
    };
    assert!(
        c.uninstall_managed_binary(&input, &[local])
            .await
            .unwrap()
            .removed
    );
    let bad = AcpRegistryPrepareInput {
        agent_id: "../x".into(),
    };
    assert_eq!(
        c.uninstall_managed_binary(&bad, &[])
            .await
            .unwrap_err()
            .detail,
        "ACP Registry managed binary uninstall received an invalid agent ID."
    );
}

#[tokio::test(start_paused = true)]
async fn prepared_binary_reservations_expire_after_thirty_seconds() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let c = catalog(dir.path(), &server, base_env());
    std::fs::create_dir_all(dir.path().join("tools/example-agent/1.2.3/linux-x86_64")).unwrap();
    c.reserve_for_test("example-agent");
    let input = prepare_input();
    assert!(
        !c.uninstall_managed_binary(&input, &[])
            .await
            .unwrap()
            .removed
    );
    tokio::time::advance(std::time::Duration::from_secs(31)).await;
    assert!(
        c.uninstall_managed_binary(&input, &[])
            .await
            .unwrap()
            .removed
    );
}

// ---- npm (npx distribution) ----

// v1 AcpRegistrySupport.test.ts:349-406.
#[tokio::test]
async fn installs_an_npm_package_into_the_managed_prefix_and_launches_its_command() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(
        json!({"npx": {"package": "@example/acp@V1.2.3", "args": ["--stdio"]}}),
    ));
    let npm = fake_npm(dir.path());
    let c = catalog(dir.path(), &server, npm.environment.clone());
    let opts = ResolveOptions::default();
    let first = c
        .resolve(
            &settings(),
            Path::new("/workspace"),
            Some(&npm.environment),
            &opts,
        )
        .await
        .unwrap();
    let second = c
        .resolve(
            &settings(),
            Path::new("/workspace"),
            Some(&npm.environment),
            &opts,
        )
        .await
        .unwrap();
    assert_eq!(first.spawn.command, npm.executable_path);
    assert_eq!(first.spawn.args, ["--stdio"]);
    assert!(first.spawn.env["PATH"].starts_with(&format!("{}:", npm.global_bin.display())));
    assert_eq!(second.spawn.command, npm.executable_path);
    let commands = log(&npm.log_path);
    assert_eq!(
        commands
            .lines()
            .filter(|l| l.starts_with("install --global "))
            .count(),
        1
    );
    assert!(commands.contains("install --global @example/acp@V1.2.3"));

    // A missing npm bin link must not select an unrelated command from the user's PATH.
    let user_bin = dir.path().join("user-bin");
    executable(&user_bin.join("example-agent"), "#!/bin/sh\n");
    std::fs::remove_file(&npm.executable_path).unwrap();
    let user_env = with_path(&npm.environment, &user_bin);
    let repaired = c
        .resolve(&settings(), Path::new("/workspace"), Some(&user_env), &opts)
        .await
        .unwrap();
    assert_eq!(repaired.spawn.command, npm.executable_path);
    assert_eq!(
        log(&npm.log_path)
            .lines()
            .filter(|l| l.starts_with("install --global "))
            .count(),
        2
    );

    std::fs::remove_file(&npm.executable_path).unwrap();
    let mut no_links = user_env.clone();
    no_links.insert("npm_config_bin_links".into(), "false".into());
    let failed = c
        .resolve(&settings(), Path::new("/workspace"), Some(&no_links), &opts)
        .await
        .unwrap_err();
    assert_eq!(failed.reason, Reason::InstallFailed);
    assert_eq!(
        failed.detail,
        "ACP Registry installed @example/acp@V1.2.3, but could not resolve its global command."
    );
}

// v1 AcpRegistrySupport.test.ts:408-446.
#[tokio::test]
async fn uses_the_managed_prefix_despite_a_system_owned_npm_prefix() {
    use std::os::unix::fs::PermissionsExt;
    /// Gives the read-only directory its write bit back however the test ends, so the temporary
    /// directory can always be removed.
    struct Writable(PathBuf);
    impl Drop for Writable {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(json!({"npx": {"package": "@example/acp@1.2.3"}})));
    let npm = fake_npm(dir.path());
    let system = dir.path().join("system-global");
    std::fs::create_dir(&system).unwrap();
    let _writable = Writable(system.clone());
    std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o555)).unwrap();
    let mut env = npm.environment.clone();
    env.insert("HOME".into(), dir.path().join("home").display().to_string());
    env.insert("FAKE_NPM_PREFIX".into(), system.display().to_string());
    let c = catalog(dir.path(), &server, env.clone());
    let resolved = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(resolved.spawn.command, npm.global_bin.join("example-agent"));
}

// v1 AcpRegistrySupport.npmShim.test.ts:18-43.
#[tokio::test]
async fn installs_with_an_npm_that_ignores_npm_config_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(json!({"npx": {"package": "@example/acp@1.2.3"}})));
    let npm = fake_npm(dir.path());
    let mut env = npm.environment.clone();
    env.insert("FAKE_NPM_IGNORE_PREFIX_ENV".into(), "1".into());
    let c = catalog(dir.path(), &server, env.clone());
    let resolved = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(resolved.spawn.command, npm.executable_path);
}

// v1 AcpRegistrySupport.npmShim.test.ts:45-75.
#[tokio::test]
async fn names_the_npm_shim_when_npm_cannot_install_into_the_managed_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(json!({"npx": {"package": "@example/acp@1.2.3"}})));
    let npm = fake_npm(dir.path());
    let mut env = npm.environment.clone();
    env.insert("FAKE_NPM_IGNORE_PREFIX".into(), "1".into());
    let c = catalog(dir.path(), &server, env.clone());
    let error = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::InstallFailed);
    assert!(error.detail.contains("shim"), "{}", error.detail);
    assert!(
        !log(&npm.log_path)
            .lines()
            .any(|l| l.starts_with("install "))
    );
}

/// Final review 6 finding C2 (v1 AcpRegistrySupport.ts:760-790 puts the manager's path and the raw
/// stderr tail in the message): a failed npm install names the manager `npm` and its stderr is
/// cleaned before it is kept: the home directory becomes `~`, tokens and sign-in links are
/// replaced.
#[tokio::test]
async fn failed_install_messages_hide_the_manager_path_home_and_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().display().to_string();
    let server = Server::start().await;
    server.registry(&example(json!({"npx": {"package": "@example/acp@1.2.3"}})));
    let npm = fake_npm(dir.path());
    let real = dir.path().join("real/npm");
    executable(&real, NPM_FIXTURE);
    executable(
        &dir.path().join("fake-node/bin/npm"),
        &format!(
            "#!/bin/sh\nif [ \"$1\" = install ]; then\n  printf '%s\\n' \"npm error log: $HOME/.npm/_logs/debug.log\" 'npm error auth: Bearer synthetic-token-0123456789' 'npm error sign in at https://accounts.google.com/o/oauth2/auth?code=synthetic-code' >&2\n  exit 1\nfi\nexec '{}' \"$@\"\n",
            real.display()
        ),
    );
    let mut env = npm.environment.clone();
    env.insert("HOME".into(), home.clone());
    let c = catalog(dir.path(), &server, env.clone());
    let error = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::InstallFailed);
    let detail = &error.detail;
    assert!(
        detail.starts_with("ACP Registry install command 'npm' exited with code 1: "),
        "{detail}"
    );
    assert!(!detail.contains(&home), "{detail}");
    assert!(detail.contains("~/.npm/_logs/debug.log"), "{detail}");
    assert!(!detail.contains("synthetic-token"), "{detail}");
    assert!(detail.contains("Bearer [redacted]"), "{detail}");
    assert!(!detail.contains("synthetic-code"), "{detail}");
    assert!(detail.contains("[sign-in-url]"), "{detail}");
}

/// C2: the shim message names both prefixes from `~` when they are under the home directory.
#[tokio::test]
async fn the_shim_message_names_home_prefixes_from_tilde() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().display().to_string();
    let server = Server::start().await;
    server.registry(&example(json!({"npx": {"package": "@example/acp@1.2.3"}})));
    let npm = fake_npm(dir.path());
    let mut env = npm.environment.clone();
    env.insert("FAKE_NPM_IGNORE_PREFIX".into(), "1".into());
    env.insert("HOME".into(), home.clone());
    let c = catalog(dir.path(), &server, env.clone());
    let error = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap_err();
    let detail = &error.detail;
    assert!(detail.contains("shim"), "{detail}");
    assert!(!detail.contains(&home), "{detail}");
    assert!(
        detail.starts_with(
            "'npm' reported global prefix ~/external-npm-global instead of GOAT's managed prefix ~/"
        ),
        "{detail}"
    );
}

// v1 AcpRegistrySupport.test.ts:498-529.
#[tokio::test]
async fn keeps_only_the_end_of_a_failed_install_output() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(json!({"npx": {"package": "@example/acp@1.2.3"}})));
    let npm = fake_npm(dir.path());
    let mut env = npm.environment.clone();
    env.insert("FAKE_NPM_INSTALL_FAILURE_LINES".into(), "40000".into());
    let c = catalog(dir.path(), &server, env.clone());
    let error = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::InstallFailed);
    assert!(error.detail.contains("exited with code 1"));
    assert!(
        error
            .detail
            .ends_with("npm error see the complete log for details")
    );
    let tail = error.detail.split("exited with code 1: ").nth(1).unwrap();
    assert!(tail.chars().count() <= 1_000);
}

// v1 AcpRegistrySupport.noInstall.test.ts:72-105.
#[tokio::test]
async fn resolves_prepared_packages_for_probes_without_installing_missing_ones() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let document = example(json!({"npx": {"package": "@example/acp@1.2.3"}}));
    write_cached_registry(dir.path(), &document);
    server.registry(&document);
    let npm = fake_npm(dir.path());
    let c = catalog(dir.path(), &server, npm.environment.clone());
    let env = Some(&npm.environment);
    assert!(matches!(
        c.inspect(&settings(), env).await.unwrap(),
        Inspection::Unprepared { .. }
    ));
    let probe = ResolveOptions {
        allow_install: false,
        spawn_environment: None,
    };
    let absent = c
        .resolve(&settings(), Path::new("/w"), env, &probe)
        .await
        .unwrap_err();
    assert_eq!(absent.reason, Reason::RunnerUnavailable);
    assert_eq!(
        absent.detail,
        "ACP Registry agent example-agent has not been prepared on this environment."
    );
    assert_eq!(log(&npm.log_path), "");
    let installed = c
        .resolve(
            &settings(),
            Path::new("/w"),
            env,
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert!(matches!(
        c.inspect(&settings(), env).await.unwrap(),
        Inspection::Ready { .. }
    ));
    let after_install = log(&npm.log_path);
    assert!(after_install.contains("install"));
    let probed = c
        .resolve(&settings(), Path::new("/w"), env, &probe)
        .await
        .unwrap();
    assert_eq!(probed.spawn.command, installed.spawn.command);
    assert_eq!(log(&npm.log_path), after_install);
    assert_eq!(server.count("/registry.json"), 0);
}

// v1 AcpRegistrySupport.noInstall.test.ts:43-70.
#[tokio::test]
async fn does_not_download_a_missing_binary_for_a_probe() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let document = example(
        json!({"binary": {"linux-x86_64": {"archive": "https://registry.test/agent.bin", "cmd": "agent"}}}),
    );
    write_cached_registry(dir.path(), &document);
    server.registry(&document);
    let c = catalog(dir.path(), &server, base_env());
    let probe = ResolveOptions {
        allow_install: false,
        spawn_environment: None,
    };
    let error = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&Environment::new()),
            &probe,
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::RunnerUnavailable);
    assert!(server.requests.lock().unwrap().is_empty());
}

// ---- uv (uvx distribution) ----

// v1 AcpRegistrySupport.test.ts:531-567 and AcpRegistrySupport.noInstall.test.ts:20-41.
#[tokio::test]
async fn installs_with_uv_and_launches_the_managed_command_over_a_path_namesake() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(
        json!({"uvx": {"package": "fast-agent-acp==0.10.1", "args": ["--acp"]}}),
    ));
    let uv = fake_uv(dir.path());
    let c = catalog(dir.path(), &server, uv.environment.clone());

    let probe = ResolveOptions {
        allow_install: false,
        spawn_environment: None,
    };
    let error = c
        .resolve(&settings(), Path::new("/w"), Some(&uv.environment), &probe)
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::RunnerUnavailable);
    assert_eq!(log(&uv.log_path), "");

    let user_bin = dir.path().join("user-bin");
    executable(&user_bin.join("example-agent"), "#!/bin/sh\n");
    let env = with_path(&uv.environment, &user_bin);
    let resolved = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(resolved.spawn.command, uv.executable_path);
    assert_eq!(resolved.spawn.args, ["--acp"]);
    assert!(resolved.spawn.env["PATH"].starts_with(&format!("{}:", uv.global_bin.display())));
    let commands = log(&uv.log_path);
    assert!(commands.contains("tool install --force fast-agent-acp==0.10.1"));
    assert!(commands.contains(&format!(
        "tool-dir={} bin-dir={}",
        dir.path().join("tools/example-agent/1.2.3/python").display(),
        uv.global_bin.display()
    )));
    // A recorded install is checked with uv, not reinstalled.
    c.resolve(
        &settings(),
        Path::new("/w"),
        Some(&env),
        &ResolveOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(log(&uv.log_path).matches("tool install").count(), 1);
    assert!(matches!(
        c.inspect(&settings(), Some(&env)).await.unwrap(),
        Inspection::Ready {
            distribution: LaunchKind::Uvx,
            ..
        }
    ));
    assert!(
        c.resolve(&settings(), Path::new("/w"), Some(&env), &probe)
            .await
            .is_ok()
    );
    assert!(c.managed_binary_directories().contains(&uv.global_bin));
}

#[tokio::test]
async fn reports_a_missing_package_manager() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(
        json!({"uvx": {"package": "fast-agent-acp==0.10.1"}}),
    ));
    let c = catalog(dir.path(), &server, base_env());
    let empty: Environment = [("PATH".to_owned(), dir.path().display().to_string())].into();
    let error = c
        .resolve(
            &settings(),
            Path::new("/w"),
            Some(&empty),
            &ResolveOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::RunnerUnavailable);
    assert_eq!(
        error.detail,
        "ACP Registry agent example-agent requires 'uv', but it is not available on this environment's PATH."
    );
    assert_eq!(
        serde_json::to_value(c.inspect(&settings(), Some(&empty)).await.unwrap()).unwrap(),
        json!({"status": "missing_runner", "agentId": "example-agent", "version": "1.2.3", "distribution": "uvx", "runner": "uv"})
    );
}

// ---- local commands, overrides and presets ----

// v1 AcpRegistrySupport.test.ts:116-292.
#[tokio::test]
async fn resolves_local_commands_without_the_registry() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let bin = dir.path().join("bin");
    executable(&bin.join("my-agent"), "#!/bin/sh\n");
    let env = with_path(&base_env(), &bin);
    let c = catalog(dir.path(), &server, env.clone());
    let local = RegistrySettings {
        source: Source::Local,
        command_path: " my-agent ".into(),
        command_args: vec!["acp".into()],
        ..RegistrySettings::default()
    };
    let resolved = c
        .resolve(
            &local,
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(resolved.spawn.command, bin.join("my-agent"));
    assert_eq!(resolved.spawn.args, ["acp"]);
    assert_eq!(resolved.spawn.env, env);
    assert_eq!(resolved.distribution, LaunchKind::Local);
    assert!(resolved.agent.is_none());
    assert_eq!(
        serde_json::to_value(c.inspect(&local, Some(&env)).await.unwrap()).unwrap(),
        json!({"status": "ready", "agentId": "my-agent", "version": null, "distribution": "local"})
    );
    let missing = RegistrySettings {
        command_path: "absent".into(),
        ..local.clone()
    };
    let error = c
        .resolve(
            &missing,
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::RunnerUnavailable);
    assert_eq!(
        error.detail,
        "Local ACP executable is not available on this environment's PATH."
    );
    assert_eq!(
        serde_json::to_value(c.inspect(&missing, Some(&env)).await.unwrap()).unwrap(),
        json!({"status": "missing_runner", "version": null, "distribution": "local"})
    );
    std::fs::write(bin.join("plain"), "not executable").unwrap();
    let plain = RegistrySettings {
        command_path: "plain".into(),
        ..local.clone()
    };
    assert!(
        c.resolve(
            &plain,
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default()
        )
        .await
        .is_err()
    );
    let empty = RegistrySettings {
        command_path: "".into(),
        ..local
    };
    assert_eq!(
        c.resolve(&empty, Path::new("/w"), None, &ResolveOptions::default())
            .await
            .unwrap_err()
            .reason,
        Reason::AgentNotConfigured
    );
    assert!(matches!(
        c.inspect(&empty, None).await.unwrap(),
        Inspection::Unconfigured
    ));
    assert!(server.requests.lock().unwrap().is_empty());
}

// v1 AcpRegistrySupport.ts:1557-1566 on a win32 host.
#[tokio::test]
async fn rejects_windows_batch_wrappers_for_local_commands() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    std::fs::write(dir.path().join("agent.cmd"), "@echo off").unwrap();
    let env: Environment = [("Path".to_owned(), dir.path().display().to_string())].into();
    let c = catalog_with(dir.path(), &server, env.clone(), "win32");
    let local = RegistrySettings {
        source: Source::Local,
        command_path: "agent".into(),
        ..RegistrySettings::default()
    };
    let error = c
        .resolve(
            &local,
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::RunnerUnavailable);
    assert!(
        error
            .detail
            .starts_with("Local ACP commands launch without a shell.")
    );
}

// v1 AcpRegistrySupport.test.ts:294-347.
#[tokio::test]
async fn command_overrides_keep_registry_arguments_and_environment() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(json!({"npx": {"package": "@example/acp@1.2.3", "args": ["--stdio"], "env": {"MODE": "acp"}}})));
    let bin = dir.path().join("bin");
    executable(&bin.join("custom-agent"), "#!/bin/sh\n");
    let env = with_path(&base_env(), &bin);
    let c = catalog(dir.path(), &server, env.clone());
    let overridden = RegistrySettings {
        command_path: "custom-agent".into(),
        ..settings()
    };
    let resolved = c
        .resolve(
            &overridden,
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(resolved.spawn.command, bin.join("custom-agent"));
    assert_eq!(resolved.spawn.args, ["--stdio"]);
    assert_eq!(resolved.spawn.env["MODE"], "acp");
    assert_eq!(resolved.distribution, LaunchKind::Npx);
    let Inspection::Ready {
        version,
        launch_identity,
        ..
    } = c.inspect(&overridden, Some(&env)).await.unwrap()
    else {
        panic!("override not ready")
    };
    assert_eq!(version, None);
    assert!(
        launch_identity
            .unwrap()
            .contains("\"commandOverride\":\"custom-agent\"")
    );
    let missing = RegistrySettings {
        command_path: "nope".into(),
        ..settings()
    };
    assert_eq!(
        c.resolve(
            &missing,
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default()
        )
        .await
        .unwrap_err()
        .detail,
        "ACP Registry agent example-agent requires 'nope', but it is not available on this provider instance's PATH."
    );
}

#[tokio::test]
async fn resolves_local_presets() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let bin = dir.path().join("bin");
    executable(&bin.join("omp"), "#!/bin/sh\n");
    let env = with_path(&base_env(), &bin);
    let c = catalog(dir.path(), &server, env.clone());
    let preset = LocalPreset::find("omp").unwrap().settings();
    let launch = c
        .launch(&preset, Path::new("/w"), Some(&env), true)
        .await
        .unwrap();
    assert_eq!(launch.flavor.command.program, bin.join("omp"));
    assert_eq!(
        launch.flavor.command.args,
        ["acp", "--approval-mode", "always-ask"]
    );
    assert!(launch.flavor.local);
    assert_eq!(launch.flavor.agent_id, "omp");
    // The agent runs with exactly the resolved environment (final review finding 3).
    assert_eq!(
        launch.flavor.command.env,
        launch
            .resolved
            .spawn
            .env
            .clone()
            .into_iter()
            .collect::<Vec<_>>()
    );
    assert_eq!(
        launch.flavor.command.env_remove,
        [crate::process::REMOVE_INHERITED]
    );
    let mcode = LocalPreset::find("minimax-code").unwrap().settings();
    assert_eq!(
        c.resolve(
            &mcode,
            Path::new("/w"),
            Some(&env),
            &ResolveOptions::default()
        )
        .await
        .unwrap_err()
        .reason,
        Reason::RunnerUnavailable
    );
}

// ---- catalog edges ----

#[tokio::test]
async fn registry_errors_name_the_agent_and_platform() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&example(
        json!({"uvx": {"package": "fast-agent-acp==0.10.1"}}),
    ));
    let c = catalog(dir.path(), &server, base_env());
    let none = RegistrySettings::default();
    assert_eq!(
        c.resolve(&none, Path::new("/w"), None, &ResolveOptions::default())
            .await
            .unwrap_err()
            .detail,
        "ACP Registry provider requires a registry agent ID."
    );
    let unknown = RegistrySettings {
        agent_id: "other".into(),
        ..settings()
    };
    assert_eq!(
        c.resolve(&unknown, Path::new("/w"), None, &ResolveOptions::default())
            .await
            .unwrap_err()
            .detail,
        "ACP Registry does not contain agent 'other'."
    );
    assert_eq!(
        serde_json::to_value(c.inspect(&unknown, None).await.unwrap()).unwrap(),
        json!({"status": "not_found", "agentId": "other"})
    );
    let binary = RegistrySettings {
        distribution: super::settings::DistributionPreference::Binary,
        ..settings()
    };
    let error = c
        .resolve(&binary, Path::new("/w"), None, &ResolveOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::UnsupportedDistribution);
    assert_eq!(
        error.detail,
        "ACP Registry agent example-agent has no binary distribution for linux-x64."
    );
    assert!(matches!(
        c.inspect(&binary, None).await.unwrap(),
        Inspection::Unsupported { .. }
    ));

    let freebsd = AcpRegistryCatalog::new(
        CatalogOptions {
            registry_url: Some(REGISTRY_URL.into()),
            ..CatalogOptions::under(dir.path())
        },
        server.transport(),
        Arc::new(server.transport()),
        HostContext {
            platform: "freebsd".into(),
            architecture: "x64".into(),
            environment: base_env(),
        },
    );
    let error = freebsd.prepare(&prepare_input()).await.unwrap_err();
    assert_eq!(error.reason, Reason::RunnerUnavailable);
    let auto = freebsd
        .resolve(
            &RegistrySettings {
                distribution: super::settings::DistributionPreference::Binary,
                ..settings()
            },
            Path::new("/w"),
            None,
            &ResolveOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(auto.reason, Reason::UnsupportedPlatform);
}

#[tokio::test]
async fn search_hides_agents_whose_package_manager_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.registry(&registry(&[
        agent("npm-agent", "1.0.0", json!({"npx": {"package": "npm-agent@1.0.0"}})),
        agent("bin-agent", "1.0.0", json!({"binary": {"linux-x86_64": {"archive": "https://registry.test/a.bin", "cmd": "a", "sha256": "a".repeat(64)}}})),
    ]));
    let input = AcpRegistrySearchInput {
        query: "".into(),
        limit: None,
    };
    let without_npm = catalog(dir.path(), &server, base_env());
    let ids: Vec<String> = without_npm
        .search(&input)
        .await
        .unwrap()
        .agents
        .into_iter()
        .map(|a| a.id)
        .collect();
    assert_eq!(ids, ["bin-agent"]);
    // Searches within five minutes reuse the fetched index.
    without_npm.search(&input).await.unwrap();
    assert_eq!(server.count("/registry.json"), 1);
    let npm = fake_npm(dir.path());
    let with_npm = catalog(dir.path(), &server, npm.environment);
    let found = with_npm.search(&input).await.unwrap().agents;
    assert_eq!(found.len(), 2);
    assert_eq!(
        serde_json::to_value(&found[0]).unwrap()["integrity"],
        if found[0].id == "bin-agent" {
            "sha256"
        } else {
            "registry"
        }
    );
}

#[tokio::test]
async fn launch_gives_antigravity_a_run_temp_directory_and_claude_its_v2_flag() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    server.route("/ag.bin", 200, "#!/bin/sh\n");
    server.registry(&registry(&[agent(
        "antigravity-acp",
        "1.0.0",
        json!({"binary": {"linux-x86_64": {
        "archive": "https://registry.test/ag.bin", "cmd": "antigravity", "args": ["acp"]}}}),
    )]));
    let c = catalog(dir.path(), &server, base_env());
    let settings = RegistrySettings {
        agent_id: "antigravity-acp".into(),
        ..RegistrySettings::default()
    };
    let launch = c
        .launch(&settings, Path::new("/w"), None, true)
        .await
        .unwrap();
    assert_eq!(launch.flavor.agent_id, "antigravity-acp");
    assert!(!launch.flavor.local);
    assert_eq!(launch.flavor.command.args, ["acp"]);
    let lease = launch.runtime_temp.expect("antigravity temp");
    let tmp = lease.directory().to_path_buf();
    assert!(tmp.starts_with(dir.path().join("runtime-tmp/acp-registry")));
    assert!(
        launch
            .flavor
            .command
            .env
            .contains(&("TMPDIR".to_owned(), tmp.display().to_string()))
    );
    assert_eq!(
        launch.flavor.command.env,
        launch
            .resolved
            .spawn
            .env
            .clone()
            .into_iter()
            .collect::<Vec<_>>()
    );
    assert_eq!(
        launch.flavor.command.env_remove,
        [crate::process::REMOVE_INHERITED]
    );
    drop(lease);
    assert!(!tmp.exists());

    let bin = dir.path().join("bin");
    executable(&bin.join("claude-agent-acp"), "#!/bin/sh\n");
    let env = with_path(&base_env(), &bin);
    let claude = RegistrySettings {
        source: Source::Local,
        command_path: "claude-agent-acp".into(),
        ..RegistrySettings::default()
    };
    let launch = c
        .launch(&claude, Path::new("/w"), Some(&env), true)
        .await
        .unwrap();
    assert!(launch.runtime_temp.is_none());
    assert!(launch.flavor.command.env.contains(&(
        "CLAUDE_AGENT_ACP_EXPERIMENTAL_V2".to_owned(),
        "1".to_owned()
    )));
    assert!(launch.flavor.command.env.iter().any(|(k, _)| k == "PATH"));
}

/// The host's UI bearer token (GOAT2_HOST_TOKEN) carried over from the host snapshot does not reach
/// a registry agent's environment, as lane B's driver keeps it out (round 7 part 2.1).
#[test]
fn a_base_environment_holding_the_host_token_does_not_pass_it_to_the_agent() {
    let base: Environment = [
        ("GOAT2_HOST_TOKEN".to_owned(), "ui-secret".to_owned()),
        ("PATH".to_owned(), "/usr/bin".to_owned()),
    ]
    .into_iter()
    .collect();
    let spawn = SpawnSpec {
        command: PathBuf::from("/usr/bin/agent"),
        args: Vec::new(),
        cwd: PathBuf::from("/w"),
        env: base.clone(),
    };
    let command = launch_command(&spawn, &base);
    assert!(
        !command.env.iter().any(|(k, _)| k == "GOAT2_HOST_TOKEN"),
        "the agent inherited the host's UI token: {:?}",
        command.env
    );
    assert!(command.env.iter().any(|(k, _)| k == "PATH"));
}

/// The agent process gets exactly the environment the registry resolved: a variable the GOAT
/// process holds outside the host snapshot is not inherited, and a snapshot value wins over the
/// process's own (v1 AcpRegistrySupport.ts:1739-1743,1840-1856 spawns with the whole resolved
/// environment; final review finding 3).
#[tokio::test]
async fn the_agent_process_gets_exactly_the_resolved_environment() {
    let outside = std::env::vars()
        .map(|(name, _)| name)
        .find(|name| name != "PATH" && !crate::probe::support::is_host_identity(name))
        .expect("the test process has an environment variable besides PATH");
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start().await;
    let dump = dir.path().join("env.txt");
    let agent = dir.path().join("agent");
    executable(
        &agent,
        &format!("#!/bin/sh\n/usr/bin/env > '{}'\n", dump.display()),
    );
    let c = catalog(dir.path(), &server, base_env());
    let settings = RegistrySettings {
        source: Source::Local,
        command_path: agent.display().to_string(),
        ..RegistrySettings::default()
    };
    let launch = c.launch(&settings, dir.path(), None, true).await.unwrap();
    let resolved = launch.resolved.spawn.env.clone();
    assert!(!resolved.contains_key(&outside));
    let factory = crate::AcpEngineFactory::new(Arc::new(launch.flavor)).for_probe();
    // The script exits without speaking ACP; the start fails after it wrote its environment.
    assert!(
        factory
            .start_inner(crate::probe::probe_spec(dir.path(), None))
            .await
            .is_err()
    );
    let child: Environment = std::fs::read_to_string(&dump)
        .unwrap()
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    assert!(
        !child.contains_key(&outside),
        "the agent inherited {outside} from the GOAT process"
    );
    assert_eq!(child.get("PATH"), resolved.get("PATH"));
    // /bin/sh itself adds PWD, SHLVL, OLDPWD and _.
    for name in child.keys() {
        assert!(
            resolved.contains_key(name) || ["PWD", "SHLVL", "OLDPWD", "_"].contains(&name.as_str()),
            "the agent got {name}, which the registry did not resolve"
        );
    }
}
