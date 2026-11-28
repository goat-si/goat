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
use crate::engine::codex::CodexFactory;
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
    /// Engine process groups alive at the last write; killed by the next start.
    #[serde(default)]
    pub engine_groups: Vec<i32>,
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

/// Kill process groups a previous host left behind (never our own group).
#[cfg(unix)]
fn kill_leftovers(previous: &HostJson) {
    let own = own_pgid();
    let mut groups = previous.engine_groups.clone();
    if previous.pid != std::process::id() {
        groups.push(previous.pgid);
    }
    for pgid in groups {
        if pgid > 1 && pgid != own {
            // SAFETY: kill with a negative pid signals a process group; errors are ignored.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(not(unix))]
fn kill_leftovers(_previous: &HostJson) {}

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
    if let Some(previous) = &previous {
        kill_leftovers(previous);
    }
    let generated_token = cfg.ui_token.is_none();
    let ui_token = cfg.ui_token.clone().unwrap_or_else(crate::util::new_token);

    let stall = StallRecorder::open(&data_dir).map_err(|e| format!("stall log: {e}"))?;
    let ticker = stall.spawn_ticker();
    let (store, report) = LaneAStore::open(&data_dir).map_err(|e| format!("thread store: {e}"))?;
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
            EngineChoice::Codex => Arc::new(CodexFactory),
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
        engine_groups: Vec::new(),
    };
    write_host_json(&host_json, &base).map_err(|e| format!("host.json: {e}"))?;
    let state = Arc::new(Mutex::new(base));
    {
        let (state, path) = (state.clone(), host_json.clone());
        host.on_engine_groups(move |groups| {
            let mut s = state.lock().expect("host.json");
            s.engine_groups = groups;
            let _ = write_host_json(&path, &s);
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
