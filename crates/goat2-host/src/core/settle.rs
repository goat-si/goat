//! Restart settlement (PRD runtime.md "재시작"), after the store opened.
//!
//! The store settles runs left active when it opens (lane A `Store::open`, DESIGN.md "Startup"
//! step 4): a run that reached the engine ends `interrupted`; one that did not ends `unknown` and
//! opens `resend:<runId>` holding its inputs, never re-sent automatically. Here the host does the
//! rest:
//! - a worker that was running wakes its parent with `child.reported(interrupted_by_restart)`;
//! - a parent whose child finished without a report (crash in between) gets that report;
//! - a parent whose settled run recorded a child result for a wait that died with the process
//!   is woken with that result;
//! - queued inputs start in order.

use std::collections::HashSet;

use goat2_contracts::{ChildResultStatus, LogEvent, RunOutcome, ThreadCursor, ThreadId};

use super::actor::{Msg, wake_input};
use super::{ChildOutcome, Host};
use crate::store::StoreResult;

pub(crate) async fn settle_and_resume(host: &Host, settled: &[ThreadId]) -> StoreResult<()> {
    let store = host.inner.store.clone();
    let restarted: HashSet<&ThreadId> = settled.iter().collect();
    // Every start re-checks every parent whose last run ended without completing (settled now or
    // by an earlier start whose recovery a crash cut short), until each lost result has a
    // durable wake input. Results that already have one are skipped.
    let mut recheck: Vec<ThreadId> = settled.to_vec();
    for card in store.cards() {
        if let Some(fold) = store.fold(&card.id)
            && fold.active_run_id.is_none()
            && matches!(
                fold.last_run_outcome,
                Some(RunOutcome::Interrupted | RunOutcome::Unknown | RunOutcome::Failed)
            )
            && !recheck.contains(&card.id)
        {
            recheck.push(card.id.clone());
        }
    }
    for parent in &recheck {
        rewake_lost_wait_results(host, parent).await;
    }
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
            let status = if settled_now {
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
    for card in store.cards() {
        // Queued inputs need their actor; so does a session sign-in or a runless engine request
        // left open by the previous process (an idle thread too): its actor closes it when it
        // starts. Held inputs too: an engine continuation cut off by the restart must be
        // dropped, never resent (a held queue stays blocked, so waking runs nothing).
        if store.fold(&card.id).is_some_and(|f| {
            !f.queued_inputs.is_empty()
                || !f.held_inputs.is_empty()
                || f.open_requests.iter().any(|r| {
                    r.run_id.is_none()
                        && (r.kind == goat2_contracts::RequestKind::Signin
                            || r.item_id.as_ref().is_some_and(|i| {
                                i.as_str()
                                    .starts_with(super::actor::SESSION_REQUEST_ITEM_PREFIX)
                            }))
                })
        }) {
            host.send(&card.id, Msg::Tick);
        }
    }
    Ok(())
}

/// A parent whose run the store settled may have recorded a child result that was meant for a
/// wait in that run (no wake input) and then lost the wait with the process. Wake it with every
/// such result, so no child result is lost; a duplicate wake is harmless, a lost one is not.
async fn rewake_lost_wait_results(host: &Host, parent: &ThreadId) {
    let store = host.inner.store.clone();
    let id = parent.clone();
    let lines = tokio::task::spawn_blocking(move || store.read_after(&id, 0))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let Some(run_start) = lines
        .iter()
        .rposition(|l| matches!(l.event, LogEvent::RunStarted(_)))
    else {
        return;
    };
    let after = &lines[run_start..];
    for (i, line) in after.iter().enumerate() {
        let LogEvent::ChildReported(reported) = &line.event else {
            continue;
        };
        // The exact wake key of this result (same as wake_input): one child can report several
        // runs, and a wake for one run does not cover another.
        let key = format!(
            "child:{}:{}",
            reported.child_thread_id,
            reported
                .child_run_id
                .as_ref()
                .map_or("restart", |r| r.as_str())
        );
        let woken = after[i..].iter().any(|l| {
            matches!(&l.event, LogEvent::InputAccepted(input) if input.client_request_id == key)
        });
        if woken {
            continue;
        }
        let title = host
            .inner
            .store
            .card(&reported.child_thread_id)
            .map(|c| c.title)
            .unwrap_or_default();
        let outcome = ChildOutcome {
            child_thread_id: reported.child_thread_id.clone(),
            child_run_id: reported.child_run_id.clone(),
            status: reported.status,
            summary: reported.summary.clone(),
            cursor: reported.child_cursor.clone(),
        };
        // Wait until the wake input is written before going on.
        let input = wake_input(&outcome, &title);
        if let Err(refusal) = super::commands::ask(host, parent, |tx| Msg::Input(input, tx)).await {
            tracing::warn!(thread = %parent, message = %refusal.message, "lost child result wake failed");
        }
    }
}
