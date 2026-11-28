//! Durable decisions and the inbox rows built from them.
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc) `packages/contracts/src/decisions.ts` and the
//! MCP inputs in `agentSurface/entries/decision.ts` (`goat_decision_request`, `goat_decision_answer`,
//! `goat_decision_escalate`). Not carried: environment/host routing (Part 2 is local) and
//! `requiredProfile` (GOAT 2 has no permission profiles yet). Silence never approves.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{RequestId, ThreadId};
use crate::log::DecisionOption;
use crate::turn_item::{ProviderRequestKind, UserInputQuestion};

/// v1 `DecisionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecisionStatus {
    Open,
    Answered,
    Expired,
    Withdrawn,
}

/// v1 `DecisionItem.source`: a durable decision, or an engine request projected into the inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecisionSource {
    Decision,
    PendingRequest,
}

/// v1 `DecisionItem.routedTo`: who is asked first while the item is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecisionRoute {
    Parent,
    Person,
}

/// v1 `DecisionItem.from` (local fields).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionFrom {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_title: Option<String>,
    /// The local thread that launched or delegated the asking thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_thread_title: Option<String>,
}

/// v1 `DecisionItem.escalation`: set once the parent agent handed the item to the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionEscalation {
    pub by: String,
    pub at: String,
    pub reason: String,
}

/// v1 `DecisionItem.pending.approval`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionPendingApproval {
    pub kind: ProviderRequestKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt: Option<String>,
}

/// v1 `DecisionItem.pending`: the engine request a `pending_request` item projects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionPending {
    pub thread_id: ThreadId,
    pub request_id: RequestId,
    pub questions: Vec<UserInputQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub approval: Option<DecisionPendingApproval>,
}

/// v1 `DecisionItem`: one inbox row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionItem {
    pub id: String,
    pub source: DecisionSource,
    pub from: DecisionFrom,
    pub title: String,
    pub context: String,
    pub options: Vec<DecisionOption>,
    pub recommended: Option<String>,
    pub expires_at: Option<String>,
    pub status: DecisionStatus,
    pub answer: Option<String>,
    pub answered_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answered_by_label: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub human_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub routed_to: Option<DecisionRoute>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub escalation: Option<DecisionEscalation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pending: Option<DecisionPending>,
}

/// v1 `DecisionRequestInput` (MCP `decision.request`): 1 to 20 options with distinct ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRequestInput {
    pub title: String,
    pub context: String,
    /// 1 to 20 options (v1); enforced in serde and the JSON Schema.
    #[serde(deserialize_with = "decision_options")]
    #[schemars(length(min = 1, max = 20))]
    pub options: Vec<DecisionOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recommended: Option<String>,
    /// Expiry closes the request unanswered; it never approves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expires_at: Option<String>,
}

/// v1 `DecisionAnswerInput.decision` for a projected approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecisionApprovalAnswer {
    Accept,
    Decline,
}

/// v1 `DecisionAnswerInput` (MCP `decision.answer`): `optionId` for a durable decision,
/// `answers` or `decision` for a projected request; `reason` is required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionAnswerInput {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub option_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answers: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decision: Option<DecisionApprovalAnswer>,
    /// v1 `UserInputResponseReason`: 1 to 2000 characters, not blank.
    #[serde(deserialize_with = "decision_reason")]
    #[schemars(length(min = 1, max = 2000), regex(pattern = r"\S"))]
    pub reason: String,
}

/// v1 `DecisionEscalateInput` (MCP `decision.escalate`): only the asking thread's parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionEscalateInput {
    pub id: String,
    /// 1 to 2000 characters, not blank.
    #[serde(deserialize_with = "decision_reason")]
    #[schemars(length(min = 1, max = 2000), regex(pattern = r"\S"))]
    pub reason: String,
}

const DECISION_OPTIONS_MAX: usize = 20;
const DECISION_REASON_MAX_CHARS: usize = 2000;

fn decision_options<'de, D>(deserializer: D) -> Result<Vec<DecisionOption>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let options = Vec::<DecisionOption>::deserialize(deserializer)?;
    if options.is_empty() || options.len() > DECISION_OPTIONS_MAX {
        return Err(serde::de::Error::custom(format!(
            "a decision needs 1 to {DECISION_OPTIONS_MAX} options, got {}",
            options.len()
        )));
    }
    Ok(options)
}

fn decision_reason<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let reason = String::deserialize(deserializer)?;
    let chars = reason.chars().count();
    if chars == 0 || chars > DECISION_REASON_MAX_CHARS || reason.trim().is_empty() {
        return Err(serde::de::Error::custom(format!(
            "reason must be 1 to {DECISION_REASON_MAX_CHARS} characters and not blank"
        )));
    }
    Ok(reason)
}
