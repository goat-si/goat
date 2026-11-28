//! `get_turn_item {threadId, itemId}`: the whole item, read back from the engine on demand
//! (PRD part2 plan.md "덧붙인 일": GOAT 2 stores tools as name/summary/engine locator; the
//! inspector, diff and command output come from the engine when a row opens).
//!
//! The item's `engine_locator` comes from its `item.completed` line and is read through the
//! thread's live engine session (`EngineSession::read_item`). Without a live session, or when the
//! engine cannot read items, the command is refused as not available, never answered with a
//! made-up item. Starting or resuming a session only to read (no run) is lane E's host helper.

use goat2_contracts::{ItemId, LogEvent, ThreadId, TurnItem};

use crate::api::{CommandError, Reason, command_error};
use crate::core::Host;
use crate::engine::EngineError;

pub(crate) async fn get_turn_item(
    host: &Host,
    thread: &ThreadId,
    item: &ItemId,
) -> Result<TurnItem, CommandError> {
    let store = host.store().clone();
    if store.card(thread).is_none() {
        return Err(command_error(Reason::ThreadNotFound, "thread not found"));
    }
    let (t, i) = (thread.clone(), item.clone());
    let found = tokio::task::spawn_blocking(move || {
        store.read_after(&t, 0).map(|lines| {
            lines.into_iter().rev().find_map(|l| match l.event {
                LogEvent::ItemCompleted(done) if done.item.id == i => {
                    Some((done.item, done.engine_locator))
                }
                _ => None,
            })
        })
    })
    .await
    .map_err(|e| command_error(Reason::Internal, e.to_string()))?
    .map_err(|e| command_error(Reason::Internal, e.to_string()))?;
    let Some((stored, locator)) = found else {
        return Err(command_error(
            Reason::InvalidRequest,
            "no finished item with that id",
        ));
    };
    let Some(locator) = locator else {
        // Items GOAT wrote itself (questions, notices) are whole in the log.
        return Ok(stored);
    };
    let session = host
        .inner
        .sessions
        .lock()
        .expect("sessions")
        .get(thread)
        .map(|(_, s)| s.clone());
    let Some(session) = session else {
        return Err(command_error(
            Reason::NotAvailable,
            "the thread's engine is not running, so the item's details cannot be read now",
        ));
    };
    match session.read_item(&locator).await {
        Ok(mut full) => {
            full.thread_id = stored.thread_id;
            full.run_id = stored.run_id;
            Ok(full)
        }
        Err(EngineError::Unsupported(_)) => Err(command_error(
            Reason::NotAvailable,
            "this engine cannot read items back",
        )),
        Err(e) => Err(command_error(Reason::NotAvailable, e.to_string())),
    }
}
