//! LF-delimited JSON over a child's stdio: request/response matching by id plus an inbound stream
//! of every other record. Shared by the engine-helper and Pi RPC drivers.
//!
//! Framing follows v1 `provider-pi/src/server/rpc.ts:1,104-133`: split on LF only (never U+2028),
//! strip one trailing CR, drop records over the size cap and lines that are not JSON objects.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};

/// v1 caps a Pi record at two image budgets plus 8 MiB; 64 MiB covers it.
pub const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;

/// How a record is recognised as the answer to a request.
pub trait Dialect: Send + Sync + 'static {
    /// `Some((id, result))` when `record` answers request `id`.
    fn response(&self, record: &Value) -> Option<(String, Result<Value, RemoteError>)>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteError {
    pub code: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CallError {
    #[error("{}", .0.message)]
    Remote(RemoteError),
    #[error("transport down: {0}")]
    Transport(String),
    #[error("no answer within {0:?}")]
    Timeout(Duration),
}

/// What the reader hands on, in order.
#[derive(Debug)]
pub enum Inbound {
    Record(Value),
    /// stdout ended (or failed). Nothing follows.
    Closed(String),
}

type Pending = HashMap<String, oneshot::Sender<Result<Value, CallError>>>;

pub struct Connection {
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    pending: Mutex<Pending>,
    down: Mutex<Option<String>>,
}

impl Connection {
    /// Start reading `stdout`. Responses complete their calls; everything else goes to the
    /// returned receiver, followed by one [Inbound::Closed].
    pub fn start(
        stdin: ChildStdin,
        stdout: ChildStdout,
        dialect: impl Dialect,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Inbound>) {
        let connection = Arc::new(Self {
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            pending: Mutex::new(HashMap::new()),
            down: Mutex::new(None),
        });
        let (tx, rx) = mpsc::unbounded_channel();
        let reader = Arc::clone(&connection);
        tokio::spawn(async move {
            let reason = reader.read_loop(stdout, &dialect, &tx).await;
            reader.mark_down(&reason);
            let _ = tx.send(Inbound::Closed(reason));
        });
        (connection, rx)
    }

    async fn read_loop(
        &self,
        stdout: ChildStdout,
        dialect: &impl Dialect,
        tx: &mpsc::UnboundedSender<Inbound>,
    ) -> String {
        let mut reader = BufReader::with_capacity(64 * 1024, stdout);
        let mut line: Vec<u8> = Vec::new();
        let mut dropping = false;
        loop {
            let available = match reader.fill_buf().await {
                Ok([]) => return "engine closed its output".to_string(),
                Ok(bytes) => bytes,
                Err(error) => return format!("reading engine output failed: {error}"),
            };
            let (chunk, newline) = match available.iter().position(|byte| *byte == b'\n') {
                Some(at) => (&available[..at], true),
                None => (available, false),
            };
            if !dropping {
                if line.len() + chunk.len() > MAX_RECORD_BYTES {
                    line.clear();
                    dropping = true;
                } else {
                    line.extend_from_slice(chunk);
                }
            }
            let consumed = chunk.len() + usize::from(newline);
            reader.consume(consumed);
            if !newline {
                continue;
            }
            if !dropping {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&line) {
                    let record = Value::Object(map);
                    let delivered = dialect.response(&record).is_some_and(|(id, result)| {
                        self.complete(&id, result.map_err(CallError::Remote))
                    });
                    if !delivered {
                        let _ = tx.send(Inbound::Record(record));
                    }
                }
            }
            line.clear();
            dropping = false;
        }
    }

    fn complete(&self, id: &str, result: Result<Value, CallError>) -> bool {
        let sender = self.pending.lock().ok().and_then(|mut map| map.remove(id));
        if let Some(sender) = sender {
            let _ = sender.send(result);
            true
        } else {
            false
        }
    }

    fn mark_down(&self, reason: &str) {
        if let Ok(mut down) = self.down.lock()
            && down.is_none()
        {
            *down = Some(reason.to_string());
        }
        let drained: Vec<_> = self
            .pending
            .lock()
            .map(|mut map| map.drain().collect())
            .unwrap_or_default();
        for (_, sender) in drained {
            let _ = sender.send(Err(CallError::Transport(reason.to_string())));
        }
    }

    pub fn down_reason(&self) -> Option<String> {
        self.down.lock().ok().and_then(|down| down.clone())
    }

    /// Write one record without waiting for an answer.
    pub async fn send(&self, record: &Value) -> Result<(), CallError> {
        if let Some(reason) = self.down_reason() {
            return Err(CallError::Transport(reason));
        }
        let mut bytes = serde_json::to_vec(record)
            .map_err(|error| CallError::Transport(format!("encoding failed: {error}")))?;
        bytes.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        let Some(writer) = stdin.as_mut() else {
            return Err(CallError::Transport("engine input closed".to_string()));
        };
        let written = async {
            writer.write_all(&bytes).await?;
            writer.flush().await
        }
        .await;
        if let Err(error) = written {
            *stdin = None;
            return Err(CallError::Transport(format!(
                "writing to engine failed: {error}"
            )));
        }
        Ok(())
    }

    /// Send `record` (which already carries `id`) and wait for its answer.
    pub async fn call(
        &self,
        id: String,
        record: &Value,
        timeout: Duration,
    ) -> Result<Value, CallError> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id.clone(), tx);
        }
        // A reader that died between the down check and the insert drained nothing for us.
        if let Some(reason) = self.down_reason() {
            self.forget(&id);
            return Err(CallError::Transport(reason));
        }
        if let Err(error) = self.send(record).await {
            self.forget(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CallError::Transport(
                "engine connection dropped".to_string(),
            )),
            Err(_) => {
                self.forget(&id);
                Err(CallError::Timeout(timeout))
            }
        }
    }

    fn forget(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }

    /// Close the engine's stdin (it reads EOF).
    pub async fn close_input(&self) {
        self.stdin.lock().await.take();
    }
}
