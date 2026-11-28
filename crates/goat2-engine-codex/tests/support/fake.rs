//! Run the real transport against `goat2-fake-codex` replaying a transcript.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use goat2_engine_codex::process::{ChildProcess, Launch};
use goat2_engine_codex::transcript::Transcript;
use goat2_engine_codex::transport::{Connection, Inbound, TransportConfig};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedReceiver;

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

pub fn load(name: &str) -> Transcript {
    let text = std::fs::read_to_string(fixture(name)).expect("read fixture");
    serde_json::from_str(&text).expect("parse fixture")
}

/// Write a transcript to a fresh temp file.
pub fn write_temp(transcript: &Transcript) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("goat2-engine-codex-tests-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join(format!("{}-{n}.json", transcript.scenario));
    std::fs::write(&path, serde_json::to_string_pretty(transcript).unwrap())
        .expect("write transcript");
    path
}

/// A transcript built from raw entries.
pub fn transcript(scenario: &str, entries: Vec<Value>) -> Transcript {
    let mut t = Transcript::new(scenario);
    t.entries = entries
        .into_iter()
        .map(|e| serde_json::from_value(e).expect("entry"))
        .collect();
    t
}

pub fn fake_launch(path: &std::path::Path, realtime: bool) -> Launch {
    let mut launch = Launch::new(env!("CARGO_BIN_EXE_goat2-fake-codex")).arg("app-server");
    launch.env_set.push((
        "GOAT2_FAKE_CODEX_TRANSCRIPT".into(),
        path.as_os_str().to_owned(),
    ));
    if realtime {
        launch
            .env_set
            .push(("GOAT2_FAKE_CODEX_REALTIME".into(), "1".into()));
    }
    launch
}

pub struct FakeSession {
    pub child: ChildProcess,
    pub conn: Connection,
    pub inbound: UnboundedReceiver<Inbound>,
}

pub fn spawn_fake(transcript: &Transcript, realtime: bool, config: TransportConfig) -> FakeSession {
    let path = write_temp(transcript);
    let mut child = ChildProcess::spawn(&fake_launch(&path, realtime)).expect("spawn fake codex");
    let (conn, inbound) = Connection::start_with(
        child.take_stdin().unwrap(),
        child.take_stdout().unwrap(),
        None,
        config,
    );
    FakeSession {
        child,
        conn,
        inbound,
    }
}

/// Close the connection's input, wait for the fake to exit, and return its exit code and stderr.
pub async fn fake_exit_of(session: &mut FakeSession) -> (Option<i32>, String) {
    session.conn.close_input();
    let child = &mut session.child;
    let summary = tokio::time::timeout(std::time::Duration::from_secs(10), child.shutdown())
        .await
        .expect("fake codex shutdown");
    (summary.status.and_then(|s| s.code()), child.stderr_tail())
}
