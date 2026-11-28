//! Stall recorder (PRD runtime.md): `<dataDir>/logs/stalls.ndjson`, on from the first start.
//!
//! Two sources: a ticker that measures how late the async runtime wakes it (event-loop stalls),
//! and [StallRecorder::time] around actor message handlers (blocking handlers). The total stalled
//! time is also kept in memory so UI connections can leave host stalls out of "silent" checks.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::util::now_rfc3339;

/// A tick later than this is recorded.
pub const STALL_THRESHOLD: Duration = Duration::from_millis(100);
const TICK: Duration = Duration::from_millis(50);
const KEEP: usize = 1024;

#[derive(Clone)]
pub struct StallRecorder {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    recent: Mutex<VecDeque<(Instant, u64)>>,
    file: Mutex<Option<fs::File>>,
}

impl StallRecorder {
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        let dir = data_dir.join("logs");
        fs::create_dir_all(&dir)?;
        let path = dir.join("stalls.ndjson");
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            inner: Arc::new(Inner {
                path,
                recent: Mutex::new(VecDeque::new()),
                file: Mutex::new(Some(file)),
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// Append one record `{at, kind, ms, ...fields}`.
    pub fn record(&self, kind: &str, ms: u64, fields: Value) {
        let mut line = json!({ "at": now_rfc3339(), "kind": kind, "ms": ms });
        if let (Some(obj), Value::Object(extra)) = (line.as_object_mut(), fields) {
            obj.extend(extra);
        }
        if ms > 0 {
            let mut recent = self.inner.recent.lock().expect("stall");
            recent.push_back((Instant::now(), ms));
            while recent.len() > KEEP {
                recent.pop_front();
            }
        }
        if let Some(file) = self.inner.file.lock().expect("stall").as_mut() {
            let _ = writeln!(file, "{line}");
        }
    }

    /// A note without stall time (memory warnings, startup timings).
    pub fn note(&self, kind: &str, fields: Value) {
        self.record(kind, 0, fields);
    }

    /// Milliseconds of recorded stalls that ended after `since`.
    pub fn stalled_ms_since(&self, since: Instant) -> u64 {
        self.inner
            .recent
            .lock()
            .expect("stall")
            .iter()
            .filter(|(at, _)| *at >= since)
            .map(|(_, ms)| ms)
            .sum()
    }

    /// Time a synchronous section; record it when it takes longer than the threshold.
    pub fn time<T>(&self, kind: &str, fields: impl FnOnce() -> Value, f: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        let out = f();
        let took = start.elapsed();
        if took >= STALL_THRESHOLD {
            self.record(kind, took.as_millis() as u64, fields());
        }
        out
    }

    /// Spawn the event-loop ticker on the current runtime.
    pub fn spawn_ticker(&self) -> tokio::task::JoinHandle<()> {
        let rec = self.clone();
        tokio::spawn(async move {
            let mut expected = Instant::now() + TICK;
            loop {
                tokio::time::sleep_until(expected.into()).await;
                let now = Instant::now();
                let late = now.saturating_duration_since(expected);
                if late >= STALL_THRESHOLD {
                    rec.record("event_loop", late.as_millis() as u64, json!({}));
                }
                expected = now + TICK;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn ticker_records_a_blocked_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let rec = StallRecorder::open(dir.path()).unwrap();
        let start = Instant::now();
        let ticker = rec.spawn_ticker();
        tokio::time::sleep(Duration::from_millis(80)).await;
        // Block the only runtime thread.
        std::thread::sleep(Duration::from_millis(300));
        tokio::time::sleep(Duration::from_millis(120)).await;
        ticker.abort();
        let text = fs::read_to_string(rec.path()).unwrap();
        let line: Value = serde_json::from_str(text.lines().next().expect("a stall line")).unwrap();
        assert_eq!(line["kind"], "event_loop");
        assert!(line["ms"].as_u64().unwrap() >= 150, "{line}");
        assert!(rec.stalled_ms_since(start) >= 150);
    }

    #[test]
    fn time_records_slow_sections_only() {
        let dir = tempfile::tempdir().unwrap();
        let rec = StallRecorder::open(dir.path()).unwrap();
        rec.time("handler", || json!({"msg": "fast"}), || ());
        rec.time(
            "handler",
            || json!({"msg": "slow"}),
            || std::thread::sleep(Duration::from_millis(120)),
        );
        let text = fs::read_to_string(rec.path()).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("\"slow\""));
    }
}
