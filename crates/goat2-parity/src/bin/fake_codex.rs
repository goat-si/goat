use goat2_parity::fake_codex::Replay;
use serde_json::Value;
use std::{
    collections::VecDeque,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};

/// How many turn/completed frames the runner allows so far (GOAT2_PARITY_FAKE_HOLD=1): the
/// number in GOAT2_PARITY_FAKE_DIR/release, 0 when absent. Without the hold, unlimited.
fn allowed(dir: &Path, hold: bool) -> u64 {
    if !hold {
        return u64::MAX;
    }
    std::fs::read_to_string(dir.join("release"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn is_turn_completed(frame: &Value) -> bool {
    frame.get("method").and_then(Value::as_str) == Some("turn/completed")
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let transcript = PathBuf::from(
        std::env::var_os("GOAT2_PARITY_FAKE_TRANSCRIPT")
            .ok_or("missing GOAT2_PARITY_FAKE_TRANSCRIPT")?,
    );
    let dir = PathBuf::from(
        std::env::var_os("GOAT2_PARITY_FAKE_DIR").ok_or("missing GOAT2_PARITY_FAKE_DIR")?,
    );
    // The runner holds each turn open until its scenario waits for a run to end, so commands
    // meant for a running turn (queue edits, cancels, steers) reach it while it runs, as in v1.
    let hold = std::env::var_os("GOAT2_PARITY_FAKE_HOLD").is_some_and(|v| v == "1");
    let mut replay = Replay::open(&transcript, &dir)?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut stdout = io::stdout().lock();
    let mut pending: VecDeque<Value> = VecDeque::new();
    let mut completed: u64 = 0;
    loop {
        // Emit what the hold allows, in recorded order.
        while let Some(front) = pending.front() {
            if is_turn_completed(front) {
                if completed >= allowed(&dir, hold) {
                    break;
                }
                completed += 1;
            }
            serde_json::to_writer(&mut stdout, front)?;
            writeln!(stdout)?;
            pending.pop_front();
        }
        stdout.flush()?;
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                let frame = serde_json::from_str(&line)?;
                pending.extend(replay.handle(&frame)?);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}
