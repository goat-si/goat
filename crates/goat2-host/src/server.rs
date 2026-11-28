//! One 127.0.0.1 axum server (`/ws`, `/mcp`, `/health`), `host.json`, the ready line.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::routing::get;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::config::{EngineChoice, HostConfig};
use crate::core::{Host, HostOptions};
use crate::engine::EngineFactory;
use crate::engine::codex::codex_factory;
use crate::engine::fake::{FakeEngine, FakeScript};
use crate::stall::StallRecorder;
use crate::store::LaneAStore;

/// `<dataDir>/host.json`, mode 0600.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostJson {
    pub pid: u32,
    /// The host's own process group.
    pub pgid: i32,
    pub port: u16,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// The host's own group identity (leader start time + executable), checked before a later
    /// start signals that group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// Engine process groups alive at the last write, with their identity; the next start kills
    /// a group only if its leader still has exactly this identity.
    #[serde(default)]
    pub engine_groups: Vec<GroupRecord>,
}

/// A process group and the identity of its leader when it was recorded.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRecord {
    pub pgid: i32,
    /// `ps -o lstart= -o comm=` of the leader: start time and executable. A reused group id
    /// has a different start time.
    pub identity: String,
}

/// Engine-group snapshots for `host.json`. Each snapshot is numbered by the host core when it is
/// taken (Host::on_engine_groups, under the lock the groups are read under); a writer
/// whose snapshot is older than the one already written drops it, so a late writer never removes
/// a live engine group from `host.json`.
pub struct HostJsonSnapshots {
    path: PathBuf,
    state: Mutex<(HostJson, u64)>,
}

impl HostJsonSnapshots {
    pub fn new(path: PathBuf, base: HostJson) -> Self {
        Self {
            path,
            state: Mutex::new((base, 0)),
        }
    }

    /// Write snapshot `seq` unless a newer one is already written. Returns whether it wrote.
    pub fn write(&self, seq: u64, groups: Vec<GroupRecord>) -> bool {
        let mut guard = self.state.lock().expect("host.json");
        let (json, written) = &mut *guard;
        if seq <= *written {
            return false;
        }
        *written = seq;
        json.engine_groups = groups;
        let _ = write_host_json(&self.path, json);
        true
    }
}

/// The ready line printed to stdout once.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub ws_url: String,
    pub mcp_url: String,
    pub port: u16,
    pub generation: u64,
}

pub struct Running {
    pub host: Host,
    pub ready: Ready,
    pub ui_token: String,
    pub data_dir: PathBuf,
    server: tokio::task::JoinHandle<()>,
    ticker: tokio::task::JoinHandle<()>,
}

impl Running {
    /// Stop engines and the server.
    pub async fn shutdown(self) {
        self.host.shutdown().await;
        self.server.abort();
        self.ticker.abort();
        let _ = std::fs::remove_file(self.data_dir.join("host.json"));
    }
}

fn read_host_json(path: &Path) -> Option<HostJson> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_host_json(path: &Path, value: &HostJson) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&body)?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, &body)?;
    std::fs::rename(tmp, path)
}

#[cfg(unix)]
fn own_pgid() -> i32 {
    // SAFETY: getpgrp has no preconditions.
    unsafe { libc::getpgrp() }
}

#[cfg(not(unix))]
fn own_pgid() -> i32 {
    0
}

/// Identity of a process (group leader): its start time and executable, from `ps`. `None` when
/// it is not alive.
#[cfg(unix)]
pub(crate) fn process_identity(pid: i32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (!line.is_empty()).then_some(line)
}

#[cfg(not(unix))]
pub(crate) fn process_identity(_pid: i32) -> Option<String> {
    None
}

/// Kill process groups a previous host left behind. Called only after this host holds the
/// store lock (so the previous host is gone), never for our own group, and only for a group
/// whose leader still has exactly the identity recorded with it (start time + executable), so a
/// reused group id is never signalled. Returns what was killed and skipped, for the stall log.
#[cfg(unix)]
fn kill_leftovers(previous: &HostJson) -> serde_json::Value {
    let own = own_pgid();
    let mut groups: Vec<GroupRecord> = previous.engine_groups.clone();
    if previous.pid != std::process::id()
        && let Some(identity) = &previous.identity
    {
        groups.push(GroupRecord {
            pgid: previous.pgid,
            identity: identity.clone(),
        });
    }
    let (mut killed, mut skipped) = (Vec::new(), Vec::new());
    for group in groups {
        if group.pgid <= 1 || group.pgid == own {
            continue;
        }
        let now = process_identity(group.pgid);
        if now.as_deref() == Some(group.identity.as_str()) {
            // SAFETY: kill with a negative pid signals a process group; errors are ignored.
            unsafe {
                libc::kill(-group.pgid, libc::SIGKILL);
            }
            killed.push(json!({ "pgid": group.pgid, "identity": group.identity }));
        } else {
            skipped.push(json!({ "pgid": group.pgid, "recorded": group.identity, "now": now }));
        }
    }
    json!({ "killed": killed, "skipped": skipped })
}

#[cfg(not(unix))]
fn kill_leftovers(_previous: &HostJson) -> serde_json::Value {
    serde_json::Value::Null
}

/// Start the host: settle, serve, write `host.json`. The caller prints [Running::ready].
pub async fn start(cfg: HostConfig) -> Result<Running, String> {
    start_with_engine(cfg, None).await
}

/// Like [start] with an explicit engine factory (tests).
pub async fn start_with_engine(
    cfg: HostConfig,
    engine: Option<Arc<dyn EngineFactory>>,
) -> Result<Running, String> {
    let data_dir = cfg.data_dir.clone();
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("data dir {}: {e}", data_dir.display()))?;
    let host_json = data_dir.join("host.json");
    let previous = read_host_json(&host_json);
    let generated_token = cfg.ui_token.is_none();
    let ui_token = cfg.ui_token.clone().unwrap_or_else(crate::util::new_token);

    let stall = StallRecorder::open(&data_dir).map_err(|e| format!("stall log: {e}"))?;
    let ticker = stall.spawn_ticker();
    // The store lock comes first: a second host is refused here and signals nothing.
    let (store, report) = LaneAStore::open(&data_dir).map_err(|e| format!("thread store: {e}"))?;
    if let Some(previous) = &previous {
        stall.note("leftover_groups", kill_leftovers(previous));
    }
    stall.note(
        "store_open",
        serde_json::to_value(&report).unwrap_or_default(),
    );
    let settled: Vec<goat2_contracts::ThreadId> = report
        .settled
        .iter()
        .map(|s| goat2_contracts::ThreadId::new(s.thread_id.clone()))
        .collect();
    let store = Arc::new(store);
    // Bumped only once this host holds the store lock (a refused start changes nothing).
    // The generation outlives host.json (removed on a clean exit): `<dataDir>/generation`.
    let generation_path = data_dir.join("generation");
    let stored = std::fs::read_to_string(&generation_path)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let generation = stored.max(previous.as_ref().map_or(0, |p| p.generation)) + 1;
    std::fs::write(&generation_path, format!("{generation}\n"))
        .map_err(|e| format!("generation file: {e}"))?;
    let engine: Arc<dyn EngineFactory> = match engine {
        Some(engine) => engine,
        None => match cfg.engine {
            EngineChoice::Codex => Arc::new(codex_factory(&data_dir, cfg.codex_bin.as_deref())),
            EngineChoice::Fake => Arc::new(FakeEngine::new(FakeScript {
                turn_ms: 400,
                ..FakeScript::default()
            })),
        },
    };
    let default_cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_owned());
    let opts = HostOptions::new(data_dir.clone(), generation, ui_token.clone(), default_cwd);
    let host = Host::open(opts, store, engine, stall).map_err(|e| format!("host: {e}"))?;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", cfg.port))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{}: {e}", cfg.port))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let mcp_url = format!("http://127.0.0.1:{port}/mcp");
    host.set_mcp_url(mcp_url.clone());

    let base = HostJson {
        pid: std::process::id(),
        pgid: own_pgid(),
        port,
        generation,
        token: generated_token.then(|| ui_token.clone()),
        identity: process_identity(own_pgid()),
        engine_groups: Vec::new(),
    };
    write_host_json(&host_json, &base).map_err(|e| format!("host.json: {e}"))?;
    let snapshots = Arc::new(HostJsonSnapshots::new(host_json.clone(), base));
    {
        let snapshots = snapshots.clone();
        host.on_engine_groups(move |seq, groups| {
            // Identities are read with `ps` off the async runtime.
            let snapshots = snapshots.clone();
            std::thread::spawn(move || {
                let records: Vec<GroupRecord> = groups
                    .into_iter()
                    .filter_map(|pgid| {
                        Some(GroupRecord {
                            pgid,
                            identity: process_identity(pgid)?,
                        })
                    })
                    .collect();
                snapshots.write(seq, records);
            });
        });
    }

    host.start(&settled)
        .await
        .map_err(|e| format!("startup: {e}"))?;

    let health_generation = generation;
    let app = Router::new()
        .route(
            "/health",
            get(move || async move {
                axum::Json(json!({ "ok": true, "generation": health_generation }))
            }),
        )
        .merge(crate::ws::router(Arc::new(host.clone())))
        .merge(crate::mcp::router(Arc::new(host.clone())));
    let server = tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            tracing::error!(%err, "server stopped");
        }
    });
    Ok(Running {
        host,
        ready: Ready {
            ws_url: format!("ws://127.0.0.1:{port}/ws"),
            mcp_url,
            port,
            generation,
        },
        ui_token,
        data_dir,
        server,
        ticker,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    /// A process group whose leader's command name is `name` (a symlink to sleep).
    fn group_named(dir: &Path, name: &str) -> std::process::Child {
        let link = dir.join(name);
        let _ = std::os::unix::fs::symlink("/bin/sleep", &link);
        std::process::Command::new(&link)
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap()
    }

    fn alive(child: &mut std::process::Child) -> bool {
        child.try_wait().unwrap().is_none()
    }

    #[test]
    fn leftover_groups_are_killed_only_when_the_leader_identity_matches() {
        let dir = tempfile::tempdir().unwrap();
        let mut codex = group_named(dir.path(), "codex");
        let mut other = group_named(dir.path(), "sleepy");
        std::thread::sleep(std::time::Duration::from_millis(100));
        let record = |child: &std::process::Child| GroupRecord {
            pgid: child.id() as i32,
            identity: process_identity(child.id() as i32).unwrap(),
        };
        // `other` stands for a reused group id: same pgid, different leader identity.
        let mut reused = record(&other);
        reused.identity = format!("{} (recorded earlier)", reused.identity);
        let previous = HostJson {
            pid: 1,
            pgid: 1,
            engine_groups: vec![record(&codex), reused],
            ..HostJson::default()
        };
        let report = kill_leftovers(&previous);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!alive(&mut codex), "recorded engine group killed: {report}");
        assert!(
            alive(&mut other),
            "a group whose identity changed is left alone: {report}"
        );
        let _ = other.kill();
    }

    #[test]
    fn a_late_older_snapshot_never_replaces_a_newer_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let snapshots = HostJsonSnapshots::new(path.clone(), HostJson::default());
        let group = |pgid| GroupRecord {
            pgid,
            identity: format!("leader {pgid}"),
        };
        let (older, newer) = (1, 2);
        // The newer snapshot (two live engines) is written first; the older one (one engine)
        // finishes late and must not replace it.
        assert!(snapshots.write(newer, vec![group(10), group(11)]));
        assert!(!snapshots.write(older, vec![group(10)]));
        let on_disk = read_host_json(&path).unwrap();
        assert_eq!(on_disk.engine_groups, vec![group(10), group(11)]);
    }

    #[tokio::test]
    async fn a_second_host_is_refused_before_it_signals_anything() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = || HostConfig {
            data_dir: dir.path().to_path_buf(),
            port: 0,
            ui_token: Some("t".into()),
            engine: EngineChoice::Fake,
            codex_bin: None,
            exit_on_stdin_close: false,
        };
        let first = start(cfg()).await.unwrap();
        // The running host's engine group, as host.json would record it.
        let mut engine = group_named(dir.path(), "codex");
        std::thread::sleep(std::time::Duration::from_millis(100));
        let mut recorded = read_host_json(&dir.path().join("host.json")).unwrap();
        recorded.engine_groups = vec![GroupRecord {
            pgid: engine.id() as i32,
            identity: process_identity(engine.id() as i32).unwrap(),
        }];
        write_host_json(&dir.path().join("host.json"), &recorded).unwrap();
        let second = start(cfg()).await;
        // A SIGKILL lands asynchronously; give it time before looking.
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            matches!(&second, Err(e) if e.contains("locked")),
            "{:?}",
            second.as_ref().err()
        );
        assert!(alive(&mut engine), "the running host's engine is untouched");
        let health = reqwest::get(format!("http://127.0.0.1:{}/health", first.ready.port))
            .await
            .unwrap();
        assert_eq!(health.status(), 200);
        let _ = engine.kill();
        first.shutdown().await;
    }
}
