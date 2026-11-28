//! Test harness: the driver against `goat2-fake-claude` replaying a transcript.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use goat2_contracts::{
    EngineConfig, EngineDriver, EngineRef, ModelSelection, ProviderInstanceId, RuntimeMode,
    ThreadId,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, Instructions, LaunchSpec, McpEndpoint, SessionSpec,
    TurnSettings,
};
use goat2_engine_claude::{ClaudeEngineFactory, ClaudeEngineOptions};
use serde_json::Value;

pub const MCP_TOKEN: &str = "test-bearer-0123456789";

pub fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

pub struct Run {
    pub dir: PathBuf,
    pub script: PathBuf,
    pub log: PathBuf,
}

impl Run {
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "goat2-claude-test-{}-{}",
            name.replace('/', "-"),
            uuid_like()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self {
            script: fixture(name),
            log: dir.join("fake.log"),
            dir,
        }
    }

    pub fn factory(&self) -> ClaudeEngineFactory {
        let mut options = ClaudeEngineOptions::default();
        options.launch.binary = PathBuf::from(env!("CARGO_BIN_EXE_goat2-fake-claude"));
        options.launch.kill_grace = Duration::from_secs(2);
        options.interrupt_settle_timeout = Duration::from_millis(300);
        options.control_timeout = Duration::from_secs(5);
        options.steer_ack_timeout = Duration::from_secs(2);
        options.launch.env = vec![
            (
                "GOAT2_FAKE_CLAUDE_SCRIPT".into(),
                self.script.display().to_string(),
            ),
            (
                "GOAT2_FAKE_CLAUDE_LOG".into(),
                self.log.display().to_string(),
            ),
        ];
        ClaudeEngineFactory::new(options)
    }

    pub fn spec(&self, model: &str, mode: RuntimeMode, resume: Option<&str>) -> SessionSpec {
        SessionSpec {
            thread_id: ThreadId::from("thread-1"),
            engine: EngineConfig {
                provider_instance_id: ProviderInstanceId::from("claudeAgent"),
                model_selection: selection(model),
                runtime_mode: mode,
                cwd: self.dir.display().to_string(),
            },
            resume: resume.map(|id| EngineRef {
                driver: EngineDriver::ClaudeAgent,
                id: id.to_string(),
            }),
            mcp: McpEndpoint {
                url: "http://127.0.0.1:4555/mcp".into(),
                bearer_token: MCP_TOKEN.into(),
            },
            host_generation: 1,
            process_generation: 1,
            instructions: Some(Instructions {
                append_system_prompt: Some("GOAT bot brief".into()),
                first_message_preamble: None,
            }),
            instance: Some(goat2_engine_api::ProviderTarget {
                instance_id: "claudeAgent".into(),
                launch: Some(LaunchSpec {
                    binary: None,
                    args: Vec::new(),
                    env: BTreeMap::from([("GOAT2_FAKE_CLAUDE_MARKER".into(), "1".into())]),
                }),
                home: None,
                shared_home: None,
            }),
        }
    }

    pub async fn start(
        &self,
        model: &str,
        mode: RuntimeMode,
        resume: Option<&str>,
    ) -> EngineHandle {
        self.factory()
            .start(self.spec(model, mode, resume))
            .await
            .expect("start")
    }

    /// Every line the fake logged.
    pub fn log_lines(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// The fake reached the end of its transcript with no mismatch, once per process.
    pub fn assert_replayed(&self, processes: usize) {
        let lines = self.log_lines();
        let errors: Vec<&Value> = lines.iter().filter(|l| l["kind"] == "error").collect();
        assert!(errors.is_empty(), "fake-claude errors: {errors:?}");
        let done = lines.iter().filter(|l| l["kind"] == "done").count();
        assert_eq!(
            done, processes,
            "fake-claude finished {done} of {processes} processes"
        );
    }

    pub fn stdin_frames(&self) -> Vec<Value> {
        self.log_lines()
            .into_iter()
            .filter(|l| l["kind"] == "stdin")
            .map(|l| l["frame"].clone())
            .collect()
    }

    /// For a run the driver stopped (interrupt closes the CLI as v1 does): the fake saw no
    /// mismatch up to the stop and received the `interrupt` control.
    pub fn assert_stopped_after_interrupt(&self) {
        let lines = self.log_lines();
        let errors: Vec<&Value> = lines.iter().filter(|l| l["kind"] == "error").collect();
        assert!(errors.is_empty(), "fake-claude errors: {errors:?}");
        assert!(
            self.stdin_frames()
                .iter()
                .any(|f| f["request"]["subtype"] == "interrupt"),
            "no interrupt control reached the CLI"
        );
    }

    pub fn starts(&self) -> Vec<Value> {
        self.log_lines()
            .into_iter()
            .filter(|l| l["kind"] == "start")
            .collect()
    }
}

fn uuid_like() -> String {
    // Two runs of the same fixture can start within one clock tick (macOS reports microseconds).
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

impl Drop for Run {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

pub fn selection(model: &str) -> ModelSelection {
    ModelSelection {
        instance_id: ProviderInstanceId::from("claudeAgent"),
        model: model.to_string(),
        options: None,
    }
}

pub fn settings(model: &str, mode: RuntimeMode) -> TurnSettings {
    TurnSettings {
        model_selection: selection(model),
        runtime_mode: mode,
    }
}

pub async fn next(handle: &mut EngineHandle) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
        .await
        .expect("event within 10 s")
        .expect("event channel open")
}

/// Events up to and including this turn's TurnFinished.
pub async fn until_finished(handle: &mut EngineHandle) -> Vec<EngineEvent> {
    let mut events = Vec::new();
    loop {
        let event = next(handle).await;
        let done = matches!(event, EngineEvent::TurnFinished { .. });
        events.push(event);
        if done {
            return events;
        }
    }
}

/// Events up to and including the first that matches.
pub async fn until<F: Fn(&EngineEvent) -> bool>(
    handle: &mut EngineHandle,
    matches: F,
) -> Vec<EngineEvent> {
    let mut events = Vec::new();
    loop {
        let event = next(handle).await;
        let done = matches(&event);
        events.push(event);
        if done {
            return events;
        }
    }
}
