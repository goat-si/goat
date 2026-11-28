//! What Codex sends to GOAT: notifications, thread items and server requests, plus the response
//! bodies GOAT sends back. Only the fields GOAT reads are typed; everything else is ignored.
//! Unknown notification methods and item types decode to `Unknown` so newer codex keeps working.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value, json};

use super::client::{ThreadStatusWire, TurnError, TurnInfo};
use super::{RpcId, methods};

/// A notification GOAT understands, or the reason it was skipped.
#[derive(Debug, Clone, PartialEq)]
pub enum Notification {
    Error(ErrorNotification),
    ThreadStarted { thread_id: String },
    ThreadStatusChanged { thread_id: String, status: ThreadStatusWire },
    ThreadClosed { thread_id: String },
    TurnStarted(TurnNotification),
    TurnCompleted(TurnNotification),
    TurnPlanUpdated(TurnPlanUpdated),
    ItemStarted(ItemNotification),
    ItemCompleted(ItemNotification),
    AgentMessageDelta(Delta),
    PlanDelta(Delta),
    ReasoningSummaryDelta(Delta),
    ReasoningTextDelta(Delta),
    CommandOutputDelta(Delta),
    FileChangeOutputDelta(Delta),
    ServerRequestResolved { thread_id: String, request_id: RpcId },
    TokenUsageUpdated { thread_id: String, turn_id: Option<String>, usage: Value },
    McpStartupStatus(Value),
    /// A method this build does not read.
    Unknown { method: String },
    /// A known method whose params did not decode; logged and skipped.
    Malformed { method: String, error: String },
}

impl Notification {
    /// The turn a notification belongs to, when it names one.
    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Self::Error(n) => Some(&n.turn_id),
            Self::TurnStarted(n) | Self::TurnCompleted(n) => Some(&n.turn.id),
            Self::TurnPlanUpdated(n) => Some(&n.turn_id),
            Self::ItemStarted(n) | Self::ItemCompleted(n) => Some(&n.turn_id),
            Self::AgentMessageDelta(d)
            | Self::PlanDelta(d)
            | Self::ReasoningSummaryDelta(d)
            | Self::ReasoningTextDelta(d)
            | Self::CommandOutputDelta(d)
            | Self::FileChangeOutputDelta(d) => Some(&d.turn_id),
            Self::TokenUsageUpdated { turn_id, .. } => turn_id.as_deref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorNotification {
    pub error: TurnError,
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default)]
    pub will_retry: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnNotification {
    pub thread_id: String,
    pub turn: TurnInfo,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPlanUpdated {
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub plan: Vec<TurnPlanStep>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TurnPlanStep {
    pub step: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemNotification {
    pub item: ThreadItem,
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default)]
    pub started_at_ms: Option<i64>,
    #[serde(default)]
    pub completed_at_ms: Option<i64>,
}

/// A streamed text chunk.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub delta: String,
    pub item_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadOnly {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusChanged {
    thread_id: String,
    status: ThreadStatusWire,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestResolvedParams {
    thread_id: String,
    request_id: RpcId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenUsageParams {
    thread_id: String,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    token_usage: Value,
}

/// Decode a notification. Never fails: unknown methods and undecodable params are reported as
/// `Unknown` / `Malformed` so the caller can log and skip them.
pub fn parse_notification(method: &str, params: Value) -> Notification {
    fn decode<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, String> {
        serde_json::from_value(params).map_err(|error| error.to_string())
    }
    let result = match method {
        methods::ERROR => decode(params).map(Notification::Error),
        methods::THREAD_STARTED => {
            #[derive(Deserialize)]
            struct Started {
                thread: super::client::ThreadInfo,
            }
            decode::<Started>(params).map(|s| Notification::ThreadStarted {
                thread_id: s.thread.id,
            })
        }
        methods::THREAD_STATUS_CHANGED => {
            decode::<StatusChanged>(params).map(|s| Notification::ThreadStatusChanged {
                thread_id: s.thread_id,
                status: s.status,
            })
        }
        methods::THREAD_CLOSED => decode::<ThreadOnly>(params).map(|s| Notification::ThreadClosed {
            thread_id: s.thread_id,
        }),
        methods::TURN_STARTED => decode(params).map(Notification::TurnStarted),
        methods::TURN_COMPLETED => decode(params).map(Notification::TurnCompleted),
        methods::TURN_PLAN_UPDATED => decode(params).map(Notification::TurnPlanUpdated),
        methods::ITEM_STARTED => decode(params).map(Notification::ItemStarted),
        methods::ITEM_COMPLETED => decode(params).map(Notification::ItemCompleted),
        methods::AGENT_MESSAGE_DELTA => decode(params).map(Notification::AgentMessageDelta),
        methods::PLAN_DELTA => decode(params).map(Notification::PlanDelta),
        methods::REASONING_SUMMARY_DELTA => decode(params).map(Notification::ReasoningSummaryDelta),
        methods::REASONING_TEXT_DELTA => decode(params).map(Notification::ReasoningTextDelta),
        methods::COMMAND_OUTPUT_DELTA => decode(params).map(Notification::CommandOutputDelta),
        methods::FILE_CHANGE_OUTPUT_DELTA => decode(params).map(Notification::FileChangeOutputDelta),
        methods::SERVER_REQUEST_RESOLVED => {
            decode::<RequestResolvedParams>(params).map(|p| Notification::ServerRequestResolved {
                thread_id: p.thread_id,
                request_id: p.request_id,
            })
        }
        methods::TOKEN_USAGE_UPDATED => {
            decode::<TokenUsageParams>(params).map(|p| Notification::TokenUsageUpdated {
                thread_id: p.thread_id,
                turn_id: p.turn_id,
                usage: p.token_usage,
            })
        }
        methods::MCP_STARTUP_STATUS => Ok(Notification::McpStartupStatus(params)),
        other => {
            return Notification::Unknown {
                method: other.to_string(),
            };
        }
    };
    result.unwrap_or_else(|error| Notification::Malformed {
        method: method.to_string(),
        error,
    })
}

/// A Codex thread item. Item types this build does not know decode as `Unknown`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ThreadItem {
    #[serde(rename_all = "camelCase")]
    UserMessage {
        id: String,
        #[serde(default)]
        content: Vec<Value>,
        #[serde(default)]
        client_id: Option<String>,
    },
    AgentMessage {
        id: String,
        text: String,
        #[serde(default)]
        phase: Option<String>,
    },
    Plan {
        id: String,
        text: String,
    },
    Reasoning {
        id: String,
        #[serde(default)]
        summary: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    CommandExecution {
        id: String,
        command: String,
        #[serde(default)]
        command_actions: Vec<Value>,
        #[serde(default)]
        exit_code: Option<i32>,
        #[serde(default)]
        status: Option<String>,
    },
    FileChange {
        id: String,
        #[serde(default)]
        changes: Vec<FileUpdateChange>,
        #[serde(default)]
        status: Option<String>,
    },
    McpToolCall {
        id: String,
        server: String,
        tool: String,
        #[serde(default)]
        arguments: Value,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        error: Option<McpToolCallError>,
    },
    DynamicToolCall {
        id: String,
        tool: String,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        arguments: Value,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        success: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    CollabAgentToolCall {
        id: String,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default)]
        receiver_thread_ids: Vec<String>,
        #[serde(default)]
        status: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    SubAgentActivity {
        id: String,
        agent_path: String,
        agent_thread_id: String,
    },
    WebSearch {
        id: String,
        query: String,
    },
    ImageView {
        id: String,
    },
    ImageGeneration {
        id: String,
    },
    #[serde(rename_all = "camelCase")]
    Sleep {
        id: String,
        #[serde(default)]
        duration_ms: Option<i64>,
    },
    ContextCompaction {
        id: String,
    },
    EnteredReviewMode {
        id: String,
    },
    ExitedReviewMode {
        id: String,
    },
    HookPrompt {
        id: String,
    },
    FunctionCallOutput {
        id: String,
    },
    #[serde(other)]
    Unknown,
}

impl ThreadItem {
    /// The Codex item id, when the item type is known.
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::UserMessage { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::Plan { id, .. }
            | Self::Reasoning { id, .. }
            | Self::CommandExecution { id, .. }
            | Self::FileChange { id, .. }
            | Self::McpToolCall { id, .. }
            | Self::DynamicToolCall { id, .. }
            | Self::CollabAgentToolCall { id, .. }
            | Self::SubAgentActivity { id, .. }
            | Self::WebSearch { id, .. }
            | Self::ImageView { id }
            | Self::ImageGeneration { id }
            | Self::Sleep { id, .. }
            | Self::ContextCompaction { id }
            | Self::EnteredReviewMode { id }
            | Self::ExitedReviewMode { id }
            | Self::HookPrompt { id }
            | Self::FunctionCallOutput { id } => Some(id),
            Self::Unknown => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FileUpdateChange {
    pub path: String,
    #[serde(default)]
    pub kind: Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct McpToolCallError {
    pub message: String,
}

/// A request Codex sends to GOAT. Unknown methods are answered with -32601 by the transport.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerRequest {
    CommandApproval(CommandApprovalParams),
    FileChangeApproval(FileChangeApprovalParams),
    PermissionsApproval(PermissionsApprovalParams),
    UserInput(UserInputParams),
    Elicitation(ElicitationParams),
}

impl ServerRequest {
    pub fn method(&self) -> &'static str {
        match self {
            Self::CommandApproval(_) => methods::COMMAND_APPROVAL,
            Self::FileChangeApproval(_) => methods::FILE_CHANGE_APPROVAL,
            Self::PermissionsApproval(_) => methods::PERMISSIONS_APPROVAL,
            Self::UserInput(_) => methods::USER_INPUT,
            Self::Elicitation(_) => methods::ELICITATION,
        }
    }

    /// The turn the request belongs to. Elicitations may not name one.
    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Self::CommandApproval(p) => Some(&p.turn_id),
            Self::FileChangeApproval(p) => Some(&p.turn_id),
            Self::PermissionsApproval(p) => Some(&p.turn_id),
            Self::UserInput(p) => Some(&p.turn_id),
            Self::Elicitation(p) => p.turn_id.as_deref(),
        }
    }
}

/// Outcome of decoding a server request.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedRequest {
    Known(ServerRequest),
    /// Not a method GOAT handles: answer -32601.
    Unknown,
    /// A known method whose params did not decode: answer -32603 and log.
    Malformed(String),
}

pub fn parse_server_request(method: &str, params: Value) -> ParsedRequest {
    fn decode<T: serde::de::DeserializeOwned>(params: Value, wrap: fn(T) -> ServerRequest) -> ParsedRequest {
        match serde_json::from_value(params) {
            Ok(value) => ParsedRequest::Known(wrap(value)),
            Err(error) => ParsedRequest::Malformed(error.to_string()),
        }
    }
    match method {
        methods::COMMAND_APPROVAL => decode(params, ServerRequest::CommandApproval),
        methods::FILE_CHANGE_APPROVAL => decode(params, ServerRequest::FileChangeApproval),
        methods::PERMISSIONS_APPROVAL => decode(params, ServerRequest::PermissionsApproval),
        methods::USER_INPUT => decode(params, ServerRequest::UserInput),
        methods::ELICITATION => decode(params, ServerRequest::Elicitation),
        _ => ParsedRequest::Unknown,
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub available_decisions: Option<Vec<CommandDecision>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsApprovalParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// The requested profile (`RequestPermissionProfile`), granted as asked on approval.
    #[serde(default)]
    pub permissions: Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputParams {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    #[serde(default)]
    pub questions: Vec<UserInputQuestion>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub options: Option<Vec<UserInputOption>>,
    #[serde(default)]
    pub is_other: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UserInputOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitationParams {
    pub thread_id: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    pub server_name: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// `CommandExecutionApprovalDecision`, including the amendment shapes. A shape this build does not
/// know is kept verbatim as `Other` so the request is never lost.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandDecision {
    Accept,
    AcceptForSession,
    AcceptWithExecpolicyAmendment { execpolicy_amendment: Vec<String> },
    ApplyNetworkPolicyAmendment { network_policy_amendment: NetworkPolicyAmendment },
    Decline,
    Cancel,
    Other(Value),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetworkPolicyAmendment {
    pub host: String,
    /// `"allow" | "deny"`.
    pub action: String,
}

impl CommandDecision {
    /// The exact wire value.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Accept => json!("accept"),
            Self::AcceptForSession => json!("acceptForSession"),
            Self::AcceptWithExecpolicyAmendment { execpolicy_amendment } => json!({
                "acceptWithExecpolicyAmendment": { "execpolicy_amendment": execpolicy_amendment }
            }),
            Self::ApplyNetworkPolicyAmendment { network_policy_amendment } => json!({
                "applyNetworkPolicyAmendment": { "network_policy_amendment": network_policy_amendment }
            }),
            Self::Decline => json!("decline"),
            Self::Cancel => json!("cancel"),
            Self::Other(value) => value.clone(),
        }
    }

    pub fn from_value(value: Value) -> Self {
        match &value {
            Value::String(s) => match s.as_str() {
                "accept" => Self::Accept,
                "acceptForSession" => Self::AcceptForSession,
                "decline" => Self::Decline,
                "cancel" => Self::Cancel,
                _ => Self::Other(value),
            },
            Value::Object(map) if map.len() == 1 => {
                if let Some(inner) = map.get("acceptWithExecpolicyAmendment") {
                    if let Some(Ok(rule)) = inner
                        .get("execpolicy_amendment")
                        .map(|v| serde_json::from_value::<Vec<String>>(v.clone()))
                    {
                        return Self::AcceptWithExecpolicyAmendment {
                            execpolicy_amendment: rule,
                        };
                    }
                }
                if let Some(inner) = map.get("applyNetworkPolicyAmendment") {
                    if let Some(Ok(rule)) = inner
                        .get("network_policy_amendment")
                        .map(|v| serde_json::from_value::<NetworkPolicyAmendment>(v.clone()))
                    {
                        return Self::ApplyNetworkPolicyAmendment {
                            network_policy_amendment: rule,
                        };
                    }
                }
                Self::Other(value)
            }
            _ => Self::Other(value),
        }
    }
}

impl Serialize for CommandDecision {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CommandDecision {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer).map_err(D::Error::custom)?;
        Ok(Self::from_value(value))
    }
}

/// `FileChangeApprovalDecision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

/// `item/commandExecution/requestApproval` response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandApprovalResponse {
    pub decision: CommandDecision,
}

/// `item/fileChange/requestApproval` response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileChangeApprovalResponse {
    pub decision: FileChangeDecision,
}

/// `item/permissions/requestApproval` response. A decline is an empty grant for the turn.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PermissionsApprovalResponse {
    pub permissions: Value,
    /// `"turn" | "session"`.
    pub scope: String,
}

impl PermissionsApprovalResponse {
    pub fn grant(requested: &Value, session: bool) -> Self {
        let mut granted = Map::new();
        for key in ["fileSystem", "network"] {
            if let Some(value) = requested.get(key) {
                if !value.is_null() {
                    granted.insert(key.into(), value.clone());
                }
            }
        }
        Self {
            permissions: Value::Object(granted),
            scope: if session { "session" } else { "turn" }.into(),
        }
    }

    pub fn decline() -> Self {
        Self {
            permissions: Value::Object(Map::new()),
            scope: "turn".into(),
        }
    }
}

/// `item/tool/requestUserInput` response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UserInputResponse {
    pub answers: Map<String, Value>,
}

impl UserInputResponse {
    pub fn new(answers: impl IntoIterator<Item = (String, Vec<String>)>) -> Self {
        Self {
            answers: answers
                .into_iter()
                .map(|(id, values)| (id, json!({ "answers": values })))
                .collect(),
        }
    }
}

/// `mcpServer/elicitation/request` action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ElicitationAction {
    Accept,
    Decline,
    Cancel,
}

/// `mcpServer/elicitation/request` response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ElicitationResponse {
    pub action: ElicitationAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
}
