//! What GOAT sends to Codex, and the responses it reads back. Field names follow
//! `schema/codex-0.167.0` (camelCase). Responses ignore unknown fields.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `initialize` params.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub capabilities: InitializeCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub version: String,
}

/// Client capabilities. GOAT opts into the experimental API (structured questions, approval
/// decision lists) and out of `turn/diff/updated`, as GOAT v1 does
/// (`CodexAdapterV2.ts` `CODEX_CLIENT_CAPABILITIES`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities {
    pub experimental_api: bool,
    pub opt_out_notification_methods: Vec<String>,
}

impl InitializeParams {
    pub fn goat(version: &str) -> Self {
        Self {
            client_info: ClientInfo {
                name: "goat2".into(),
                title: Some("GOAT 2".into()),
                version: version.into(),
            },
            capabilities: InitializeCapabilities {
                experimental_api: true,
                opt_out_notification_methods: vec!["turn/diff/updated".into()],
            },
        }
    }
}

/// `initialize` result (fields GOAT reads).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub platform_os: Option<String>,
}

/// `thread/start` params.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// `"untrusted" | "on-request" | "never"` or a granular object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<Value>,
    /// `"read-only" | "workspace-write" | "danger-full-access"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    /// Dotted config overrides, e.g. `mcp_servers.goat`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
}

/// `thread/resume` params.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeParams {
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    /// Always true: GOAT never needs the history, only the live status.
    pub exclude_turns: bool,
}

/// `thread/start` and `thread/resume` result (fields GOAT reads).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOpenResponse {
    pub thread: ThreadInfo,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub id: String,
    #[serde(default)]
    pub status: Option<ThreadStatusWire>,
}

/// `ThreadStatus`; unknown future kinds decode as `Other`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadStatusWire {
    NotLoaded,
    Idle,
    SystemError,
    Active {
        #[serde(default, rename = "activeFlags")]
        active_flags: Vec<String>,
    },
    #[serde(other)]
    Other,
}

impl ThreadStatusWire {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Active { .. })
    }
}

/// `thread/turns/list` params.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnsListParams {
    pub thread_id: String,
    pub limit: u32,
    pub sort_direction: String,
    pub items_view: String,
}

impl ThreadTurnsListParams {
    /// Newest turns first, without item bodies.
    pub fn recent(thread_id: &str) -> Self {
        Self {
            thread_id: thread_id.into(),
            limit: 10,
            sort_direction: "desc".into(),
            items_view: "summary".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TurnsListResponse {
    #[serde(default)]
    pub data: Vec<TurnInfo>,
}

/// A user input item.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInput {
    Text {
        text: String,
        /// Codex names this field in snake_case on the wire.
        text_elements: Vec<Value>,
    },
    LocalImage {
        path: PathBuf,
    },
}

impl UserInput {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text {
            text: text.into(),
            text_elements: Vec::new(),
        }
    }
}

/// `turn/start` params.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub thread_id: String,
    pub input: Vec<UserInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_user_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<Value>,
}

/// `turn/steer` params. `expectedTurnId` is required: Codex refuses the steer when it does not
/// match the running turn.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerParams {
    pub thread_id: String,
    pub input: Vec<UserInput>,
    pub expected_turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_user_message_id: Option<String>,
}

/// `turn/interrupt` params.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams {
    pub thread_id: String,
    pub turn_id: String,
}

/// `turn/start` result.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TurnStartResponse {
    pub turn: TurnInfo,
}

/// `turn/steer` result.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerResponse {
    pub turn_id: String,
}

/// A `Turn` (fields GOAT reads).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TurnInfo {
    pub id: String,
    #[serde(default)]
    pub status: Option<TurnStatusWire>,
    #[serde(default)]
    pub error: Option<TurnError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatusWire {
    Completed,
    Interrupted,
    Failed,
    InProgress,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnError {
    pub message: String,
    #[serde(default)]
    pub additional_details: Option<String>,
}

/// Build the dotted config override that gives Codex the GOAT MCP server
/// (GOAT v1 `goatCodexServers`: `mcp_servers.<name> = {url, http_headers}`).
pub fn goat_mcp_config(url: &str, token: &str) -> Map<String, Value> {
    let mut headers = BTreeMap::new();
    headers.insert("Authorization".to_string(), format!("Bearer {token}"));
    let mut config = Map::new();
    config.insert(
        "mcp_servers.goat".into(),
        serde_json::json!({ "url": url, "http_headers": headers }),
    );
    config
}

/// Thread settings that both the driver and the session recorder turn into `thread/start` and
/// `thread/resume` params, so recorded frames and driver frames are built the same way.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThreadOptions {
    pub model: Option<String>,
    pub cwd: String,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
    pub developer_instructions: Option<String>,
    /// `(url, token)` of the GOAT MCP server.
    pub goat_mcp: Option<(String, String)>,
}

impl ThreadOptions {
    fn config(&self) -> Option<Map<String, Value>> {
        self.goat_mcp
            .as_ref()
            .map(|(url, token)| goat_mcp_config(url, token))
    }

    pub fn start_params(&self) -> ThreadStartParams {
        ThreadStartParams {
            model: self.model.clone(),
            cwd: Some(self.cwd.clone()),
            approval_policy: self.approval_policy.clone().map(Value::String),
            sandbox: self.sandbox.clone(),
            config: self.config(),
            developer_instructions: self.developer_instructions.clone(),
            ephemeral: None,
            service_name: None,
        }
    }

    pub fn resume_params(&self, thread_id: &str) -> ThreadResumeParams {
        ThreadResumeParams {
            thread_id: thread_id.into(),
            model: self.model.clone(),
            cwd: Some(self.cwd.clone()),
            approval_policy: self.approval_policy.clone().map(Value::String),
            sandbox: self.sandbox.clone(),
            config: self.config(),
            developer_instructions: self.developer_instructions.clone(),
            exclude_turns: true,
        }
    }
}

/// `turn/start` params for a text input (plus local images).
pub fn turn_start_params(
    thread_id: &str,
    text: &str,
    images: &[PathBuf],
    client_message_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> TurnStartParams {
    TurnStartParams {
        thread_id: thread_id.into(),
        input: user_inputs(text, images),
        client_user_message_id: client_message_id.map(str::to_string),
        cwd: None,
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
        approval_policy: None,
    }
}

/// `turn/steer` params.
pub fn turn_steer_params(
    thread_id: &str,
    expected_turn_id: &str,
    text: &str,
    images: &[PathBuf],
    client_message_id: Option<&str>,
) -> TurnSteerParams {
    TurnSteerParams {
        thread_id: thread_id.into(),
        input: user_inputs(text, images),
        expected_turn_id: expected_turn_id.into(),
        client_user_message_id: client_message_id.map(str::to_string),
    }
}

fn user_inputs(text: &str, images: &[PathBuf]) -> Vec<UserInput> {
    let mut input = vec![UserInput::text(text)];
    input.extend(
        images
            .iter()
            .map(|path| UserInput::LocalImage { path: path.clone() }),
    );
    input
}
