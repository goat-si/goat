//! Restart settlement (PRD runtime.md "재시작"), after the store opened.
//!
//! The store settles runs left active when it opens (lane A `Store::open`, DESIGN.md "Startup"
//! step 4): a run that reached the engine ends `interrupted`; one that did not ends `unknown` and
//! opens `resend:<runId>` holding its inputs, never re-sent automatically. Here the host does the
//! rest:
//! - a worker that was running wakes its parent with `child.reported(interrupted_by_restart)`;
//! - a parent whose child finished without a report (crash in between) gets that report;
//! - queued inputs start in order.

use std::collections::HashSet;

use goat2_contracts::{ChildResultStatus, RunOutcome, ThreadCursor, ThreadId};

use super::actor::Msg;
use super::{ChildOutcome, Host};
use crate::store::StoreResult;

pub(crate) async fn settle_and_resume(host: &Host, settled: &[ThreadId]) -> StoreResult<()> {
    let store = host.inner.store.clone();
    let restarted: HashSet<&ThreadId> = settled.iter().collect();
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
        if store
            .fold(&card.id)
            .is_some_and(|f| !f.queued_inputs.is_empty())
        {
            host.send(&card.id, Msg::Tick);
        }
    }
    Ok(())
}
