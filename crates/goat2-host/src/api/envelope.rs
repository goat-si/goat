//! The v1 agent-surface result envelope (`packages/contracts/src/agentSurface/envelope.ts`),
//! reduced to the three shapes: `ok` + value, `error` + code/reason/retryable, `needs_human`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// v1 `AgentSurfaceErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    Unauthenticated,
    PermissionDenied,
    NotFound,
    Conflict,
    Unavailable,
    Timeout,
    Expired,
    Cancelled,
    Internal,
    ResourceExhausted,
    FailedPrecondition,
    UnknownOutcome,
}

/// v1 `AgentSurfaceError`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceError {
    pub code: ErrorCode,
    /// The domain's own reason, such as `child_budget` or `no_active_run`.
    pub reason: String,
    pub message: String,
    /// True only when repeating the call cannot duplicate an effect.
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl SurfaceError {
    pub fn new(
        code: ErrorCode,
        reason: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            code,
            reason: reason.into(),
            message: message.into(),
            retryable,
            details: None,
        }
    }
}

/// v1 `AgentSurfaceHandoff`: what a person has to finish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub handoff_id: String,
    pub kind: String,
    pub title: String,
    pub state: String,
    pub expires_at: Option<String>,
    pub target_path: String,
}

/// v1 `AgentSurfaceNextCall`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextCall {
    pub after: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
}

/// v1 `AgentSurfaceResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SurfaceResult {
    Ok {
        value: Value,
    },
    Error {
        error: SurfaceError,
    },
    /// Not a failure: retrying would start a second human flow.
    NeedsHuman {
        handoff: Handoff,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next: Option<NextCall>,
    },
}

impl SurfaceResult {
    pub fn ok(value: impl Serialize) -> Self {
        Self::Ok {
            value: serde_json::to_value(value).unwrap_or(Value::Null),
        }
    }

    pub fn err(
        code: ErrorCode,
        reason: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::Error {
            error: SurfaceError::new(code, reason, message, retryable),
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

impl From<SurfaceError> for SurfaceResult {
    fn from(error: SurfaceError) -> Self {
        Self::Error { error }
    }
}
