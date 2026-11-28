//! Restart settlement (PRD runtime.md "재시작"), run once at startup before anything is sent.
//!
//! - A run with only `run.started` (never reached the engine) -> `run.finished(unknown)` and a
//!   `resend` request; its inputs are held until a person picks resend or drop. Never re-sent
//!   automatically.
//! - A run that reached the engine (`run.accepted`, an item or a request) ->
//!   `run.finished(interrupted)`.
//! - Engine requests of the dead process are cancelled; agent questions (MCP `request.ask`)
//!   stay open.
//! - A worker that was running wakes its parent with `child.reported(interrupted_by_restart)`.
//! - Queued inputs stay and start in order.

use std::collections::HashSet;

use goat2_contracts::{
    Checkpoint, ChildResultStatus, LogEvent, RequestKind, RequestOpened, RequestOutcome,
    RequestResolved, RunFinished, RunOutcome, ThreadCursor, ThreadId,
};

use super::actor::Msg;
use super::{ChildOutcome, Host};
use crate::store::{StoreResult, resend_request_id};

pub(crate) async fn settle_and_resume(host: &Host) -> StoreResult<()> {
    let store = host.inner.store.clone();
    let mut restarted: HashSet<ThreadId> = HashSet::new();
    for card in store.cards() {
        let Some(fold) = store.fold(&card.id) else {
            continue;
        };
        let mut events = Vec::new();
        for request in &fold.open_requests {
            if request.item_id.is_some() && request.kind != RequestKind::Resend {
                events.push(LogEvent::RequestResolved(RequestResolved {
                    request_id: request.request_id.clone(),
                    outcome: RequestOutcome::Cancel,
                    option_id: None,
                    text: Some("the host restarted".to_owned()),
                    answers: None,
                }));
            }
        }
        if let Some(run_id) = &fold.active_run_id {
            if fold.active_run_reached_engine {
                events.push(LogEvent::RunFinished(RunFinished {
                    run_id: run_id.clone(),
                    outcome: RunOutcome::Interrupted,
                    reason: Some("the host restarted".to_owned()),
                }));
            } else {
                events.push(LogEvent::RunFinished(RunFinished {
                    run_id: run_id.clone(),
                    outcome: RunOutcome::Unknown,
                    reason: Some("the host restarted before the engine answered".to_owned()),
                }));
                events.push(LogEvent::RequestOpened(RequestOpened {
                    request_id: resend_request_id(run_id),
                    run_id: Some(run_id.clone()),
                    item_id: None,
                    kind: RequestKind::Resend,
                    summary: "Not sure the last message reached the agent. Resend or drop it?"
                        .to_owned(),
                    options: None,
                    recommended: None,
                }));
            }
            restarted.insert(card.id.clone());
        }
        if events.is_empty() {
            continue;
        }
        host.append(&card.id, events)?;
        if let (Some(mut card), Some(fold)) = (store.card(&card.id), store.fold(&card.id)) {
            card.applied_seq += 1;
            let id = card.id.clone();
            host.append(&id, vec![LogEvent::Checkpoint(Checkpoint { card, fold })])?;
        }
    }
    // Wake parents of children that are no longer running (settled now, or finished before a
    // crash without their report).
    for parent in store.cards() {
        let Some(fold) = store.fold(&parent.id) else {
            continue;
        };
        for child_id in &fold.running_child_ids {
            let (Some(child), Some(child_fold)) = (store.card(child_id), store.fold(child_id))
            else {
                continue;
            };
            // A run settled now is reported even if the child has queued follow-ups; otherwise
            // a busy child reports after its next run.
            let settled_now = restarted.contains(child_id);
            if !settled_now
                && (child_fold.active_run_id.is_some() || !child_fold.queued_inputs.is_empty())
            {
                continue;
            }
            let status = if restarted.contains(child_id) {
                ChildResultStatus::InterruptedByRestart
            } else {
                match child_fold.last_run_outcome {
                    Some(RunOutcome::Completed) => ChildResultStatus::Completed,
                    Some(RunOutcome::Failed) => ChildResultStatus::Failed,
                    Some(RunOutcome::Interrupted) => ChildResultStatus::Interrupted,
                    _ => ChildResultStatus::Unknown,
                }
            };
            host.send(
                &parent.id,
                Msg::ChildResult {
                    outcome: ChildOutcome {
                        child_thread_id: child_id.clone(),
                        child_run_id: None,
                        status,
                        summary: child.latest_answer_excerpt.clone(),
                        cursor: ThreadCursor {
                            epoch: child.epoch.clone(),
                            seq: store.last_seq(child_id).unwrap_or(child.applied_seq),
                        },
                    },
                    delivered_in_wait: false,
                },
            );
        }
    }
    // Resume queues in order.
    for card in store.cards() {
        if store
            .fold(&card.id)
            .is_some_and(|f| !f.queued_inputs.is_empty())
        {
            host.send(&card.id, Msg::Tick);
        }
    }
    Ok(())
}
