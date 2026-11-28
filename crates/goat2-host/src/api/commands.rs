//! UI commands over the WebSocket: the command variants of `goat2_contracts::ClientFrame`
//! (send_input, start_thread, stop_thread, resume_queue, resolve_request, archive_thread,
//! rename_thread, change_thread, edit_queued, cancel_queued, reorder_queued, promote_to_steer,
//! create_bot), answered by `HostFrame::CommandResult`.
//!
//! Dedupe rule (owner 2026-11-28): every command is deduped by `clientRequestId`. Same id and
//! same arguments returns the first execution's value or error again (no new log line); same id
//! and different arguments is refused with `idempotency_conflict`. The reply always carries the
//! current frame's `reqId` (the WebSocket module sets it).

pub use goat2_contracts::{
    BotProfile, ClientFrame as Command, CommandError, CommandErrorCode, CommandValue,
};

pub type CommandReply = Result<CommandValue, CommandError>;

/// A command error with `retryable: false`.
pub fn command_error(code: CommandErrorCode, message: impl Into<String>) -> CommandError {
    CommandError {
        code,
        message: message.into(),
        retryable: false,
    }
}

/// True for the frames that are commands (they carry a `clientRequestId`).
pub fn is_command(frame: &Command) -> bool {
    frame.client_request_id().is_some()
}
