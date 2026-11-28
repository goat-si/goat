//! UI commands over the WebSocket: the command variants of `goat2_contracts::ClientFrame`
//! (send_input, start_thread, stop_thread, resume_queue, resolve_request, archive_thread,
//! rename_thread, change_thread, edit_queued, cancel_queued, reorder_queued, promote_to_steer,
//! create_bot), answered by `HostFrame::CommandResult`.
//!
//! Dedupe rule (owner 2026-11-28): every command is deduped by `clientRequestId`. Same id and
//! same arguments returns the first execution's value or error again (no new log line); same id
//! and different arguments is refused with `idempotency_conflict`. The reply always carries the
//! current frame's `reqId` (the WebSocket module sets it).
//!
//! Errors are v1 `AgentSurfaceError` (`code` from v1 `AgentSurfaceErrorCode`, `reason` the
//! domain literal), contracts R7.

pub use goat2_contracts::{
    AgentSurfaceErrorCode, BotProfile, ClientFrame as Command, CommandError, CommandValue,
};

pub type CommandReply = Result<CommandValue, CommandError>;

/// The domain reasons a command can fail with (contracts R7), each with its v1 code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Reason {
    ThreadNotFound,
    RequestNotFound,
    BotNotFound,
    NotAllowed,
    SteerRefused,
    IdempotencyConflict,
    NotQueued,
    ChildBudget,
    PayloadTooLarge,
    InvalidRequest,
    /// A command this host build does not serve yet (Part 2 frames whose module is not in).
    NotAvailable,
    /// The thread's log could not be written: it takes no more writes until the host restarts.
    RestartRequired,
    Internal,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ThreadNotFound => "thread_not_found",
            Self::RequestNotFound => "request_not_found",
            Self::BotNotFound => "bot_not_found",
            Self::NotAllowed => "not_allowed",
            Self::SteerRefused => "steer_refused",
            Self::IdempotencyConflict => "idempotency_conflict",
            Self::NotQueued => "not_queued",
            Self::ChildBudget => "child_budget",
            Self::PayloadTooLarge => "payload_too_large",
            Self::InvalidRequest => "invalid_request",
            Self::NotAvailable => "not_available",
            Self::RestartRequired => "restart_required",
            Self::Internal => "internal",
        }
    }

    /// v1 `FAILURE_CLASSES` code for the literal (`envelope.ts`): thread_not_found ->
    /// not_found, not_allowed -> permission_denied, conflicts -> conflict, budgets ->
    /// resource_exhausted, invalid input -> invalid_request.
    pub fn code(self) -> AgentSurfaceErrorCode {
        match self {
            Self::ThreadNotFound | Self::RequestNotFound | Self::BotNotFound => {
                AgentSurfaceErrorCode::NotFound
            }
            Self::NotAllowed => AgentSurfaceErrorCode::PermissionDenied,
            Self::SteerRefused => AgentSurfaceErrorCode::FailedPrecondition,
            Self::IdempotencyConflict | Self::NotQueued => AgentSurfaceErrorCode::Conflict,
            Self::ChildBudget => AgentSurfaceErrorCode::ResourceExhausted,
            Self::PayloadTooLarge | Self::InvalidRequest => AgentSurfaceErrorCode::InvalidRequest,
            Self::NotAvailable => AgentSurfaceErrorCode::Unavailable,
            Self::RestartRequired => AgentSurfaceErrorCode::FailedPrecondition,
            Self::Internal => AgentSurfaceErrorCode::Internal,
        }
    }

    /// True only when repeating cannot duplicate an effect and may succeed later.
    pub fn retryable(self) -> bool {
        matches!(self, Self::ChildBudget)
    }
}

pub fn command_error(reason: Reason, message: impl Into<String>) -> CommandError {
    CommandError {
        code: reason.code(),
        reason: reason.as_str().to_owned(),
        message: message.into(),
        retryable: reason.retryable(),
        details: None,
    }
}

/// True for the frames that are commands (they carry a `clientRequestId`).
pub fn is_command(frame: &Command) -> bool {
    frame.client_request_id().is_some()
}
