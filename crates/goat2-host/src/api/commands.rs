//! UI commands over the WebSocket.
//!
//! Lane C is adding these to `goat2-contracts` `ClientFrame` (owner 2026-11-28): send_input,
//! start_thread, stop_thread, resume_queue, resolve_request, archive_thread, rename_thread,
//! create_bot, change_thread, and the queue commands edit_queued / cancel_queued /
//! reorder_queued / promote_to_steer, answered by `command_result {reqId, ok, value?,
//! error?{code, message, retryable}}`. Until those types land, the host mirrors them here with
//! the same `type` tags and camelCase fields; switch to the contract types when they merge.

use goat2_contracts::{
    BotId, ChatAttachment, FollowUpMode, InputId, InputMode, ProjectId, RequestId, RequestOutcome,
    ThreadId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A bot profile, stored at `<dataDir>/bots/<botId>.json`. The main bot "GOAT" is created on
/// first start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotProfile {
    pub bot_id: BotId,
    pub name: String,
    /// The bot's one forever thread.
    pub thread_id: ThreadId,
    #[serde(default)]
    pub face: Option<String>,
    #[serde(default)]
    pub main: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    SendInput {
        thread_id: ThreadId,
        text: String,
        #[serde(default)]
        attachments: Vec<ChatAttachment>,
        /// Omit to use the thread's follow-up mode.
        #[serde(default)]
        mode: Option<InputMode>,
        #[serde(default)]
        client_request_id: Option<String>,
    },
    StartThread {
        #[serde(default)]
        title: Option<String>,
        cwd: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        runtime_mode: Option<String>,
        #[serde(default)]
        project_id: Option<ProjectId>,
        /// First message; optional for an empty thread.
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        client_request_id: Option<String>,
    },
    /// The Stop button: interrupt the run, hold the queue, stop wait-mode children.
    StopThread {
        thread_id: ThreadId,
    },
    ResumeQueue {
        thread_id: ThreadId,
    },
    ResolveRequest {
        thread_id: ThreadId,
        request_id: RequestId,
        #[serde(default)]
        outcome: Option<RequestOutcome>,
        /// For decision requests: the chosen option.
        #[serde(default)]
        option_id: Option<String>,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        answers: Option<serde_json::Map<String, Value>>,
    },
    ArchiveThread {
        thread_id: ThreadId,
        #[serde(default = "yes")]
        archived: bool,
    },
    RenameThread {
        thread_id: ThreadId,
        title: String,
    },
    ChangeThread {
        thread_id: ThreadId,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        runtime_mode: Option<String>,
        #[serde(default)]
        follow_up_mode: Option<FollowUpMode>,
    },
    CreateBot {
        name: String,
        #[serde(default)]
        face: Option<String>,
        cwd: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        client_request_id: Option<String>,
    },
    EditQueued {
        thread_id: ThreadId,
        input_id: InputId,
        text: String,
    },
    CancelQueued {
        thread_id: ThreadId,
        input_id: InputId,
    },
    ReorderQueued {
        thread_id: ThreadId,
        input_ids: Vec<InputId>,
    },
    PromoteToSteer {
        thread_id: ThreadId,
        input_id: InputId,
    },
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
}

pub type CommandReply = Result<Value, CommandError>;
