//! Card fold: `goat.jsonl` lines -> [ThreadCard] + [Fold], following the rules documented on
//! `goat2_contracts::Fold` (lane C) so checkpoints match what lane A's store will write.

use goat2_contracts::limits::{CARD_EXCERPT_MAX_CHARS, CARD_TITLE_MAX_CHARS};
use goat2_contracts::text::clamp_chars;
use goat2_contracts::{
    AssistantMessagePhase, ChildCounts, DeliveredAs, DeliveryOutcome, Epoch, Fold, HeldInputs,
    LogEvent, LogLine, NeedsYou, NotifyKind, QueuedInput, RequestId, RequestOutcome, RunOutcome,
    ThreadCard, ThreadId, ThreadStatus, TurnItemBody,
};

/// Card plus fold state.
#[derive(Debug, Clone, PartialEq)]
pub struct CardFold {
    pub card: ThreadCard,
    pub fold: Fold,
}

/// Request id of the resend request opened for an `unknown` run.
pub fn resend_request_id(run_id: &goat2_contracts::RunId) -> RequestId {
    RequestId::new(format!("resend:{run_id}"))
}

impl CardFold {
    pub fn from_stored(card: ThreadCard, fold: Fold) -> Self {
        Self { card, fold }
    }

    /// Status precedence (PRD model.md): open request (incl. resend) > running > queued >
    /// failed > idle.
    pub fn recompute_status(&mut self) {
        let card = &mut self.card;
        let fold = &self.fold;
        card.children = ChildCounts {
            running: fold.running_child_ids.len() as u32,
            total: card.children.total,
        };
        if let Some(request) = fold.open_requests.last() {
            card.status = ThreadStatus::NeedsYou;
            card.needs_you = Some(NeedsYou {
                kind: request.kind,
                summary: request.summary.clone(),
            });
            return;
        }
        card.needs_you = None;
        card.status = if fold.active_run_id.is_some() {
            ThreadStatus::Running
        } else if !fold.queued_inputs.is_empty() {
            ThreadStatus::Queued
        } else if fold.last_run_outcome == Some(RunOutcome::Failed) {
            ThreadStatus::Failed
        } else {
            ThreadStatus::Idle
        };
    }
}

/// Start a fold from the `thread.created` line (seq 1).
pub fn new_fold(id: &ThreadId, epoch: Epoch, line: &LogLine) -> Option<CardFold> {
    let LogEvent::ThreadCreated(created) = &line.event else {
        return None;
    };
    let mut cf = CardFold {
        card: ThreadCard {
            id: id.clone(),
            kind: created.kind,
            title: clamp_chars(&created.title, CARD_TITLE_MAX_CHARS),
            project_id: created.project_id.clone(),
            bot_id: created.bot_id.clone(),
            parent: created.parent.clone(),
            engine: created.engine.clone(),
            engine_ref: None,
            status: ThreadStatus::Idle,
            needs_you: None,
            latest_answer_excerpt: String::new(),
            children: ChildCounts::default(),
            follow_up_mode: created.follow_up_mode,
            archived_at: None,
            updated_at: line.at.clone(),
            epoch,
            applied_seq: line.seq,
            card_seq: 0,
        },
        fold: Fold::default(),
    };
    cf.recompute_status();
    Some(cf)
}

fn is_active_run(fold: &Fold, run_id: Option<&goat2_contracts::RunId>) -> bool {
    run_id.is_some() && fold.active_run_id.as_ref() == run_id
}

/// Apply one line after `thread.created`.
pub fn fold_line(cf: &mut CardFold, line: &LogLine) {
    let card = &mut cf.card;
    let fold = &mut cf.fold;
    match &line.event {
        LogEvent::ThreadCreated(_) | LogEvent::Checkpoint(_) => {}
        LogEvent::ThreadChanged(change) => {
            if let Some(title) = &change.title {
                card.title = clamp_chars(title, CARD_TITLE_MAX_CHARS);
            }
            if let Some(selection) = &change.model_selection {
                card.engine.provider_instance_id = selection.instance_id.clone();
                card.engine.model_selection = selection.clone();
            }
            if let Some(mode) = change.runtime_mode {
                card.engine.runtime_mode = mode;
            }
            if let Some(mode) = change.follow_up_mode {
                card.follow_up_mode = mode;
            }
            if let Some(archived_at) = &change.archived_at {
                card.archived_at = archived_at.clone();
            }
        }
        LogEvent::InputAccepted(input) => {
            fold.counters.inputs += 1;
            if !fold
                .queued_inputs
                .iter()
                .any(|q| q.input_id == input.input_id)
            {
                fold.queued_inputs.push(QueuedInput {
                    input_id: input.input_id.clone(),
                    text: input.text.clone(),
                    mode: input.mode,
                    source: input.from.clone(),
                    attachments: input.attachments.clone(),
                });
            }
        }
        LogEvent::InputChanged(change) => {
            if let Some(index) = fold
                .queued_inputs
                .iter()
                .position(|q| q.input_id == change.input_id)
            {
                if change.cancelled == Some(true) {
                    fold.queued_inputs.remove(index);
                } else {
                    let mut input = fold.queued_inputs.remove(index);
                    if let Some(text) = &change.text {
                        input.text = text.clone();
                    }
                    if let Some(mode) = change.mode {
                        input.mode = mode;
                    }
                    let at = change
                        .position
                        .map_or(index, |p| (p as usize).min(fold.queued_inputs.len()));
                    fold.queued_inputs.insert(at, input);
                }
            }
        }
        LogEvent::InputDelivered(delivered) => match delivered.outcome {
            DeliveryOutcome::Accepted => {
                fold.queued_inputs
                    .retain(|q| q.input_id != delivered.input_id);
                if delivered.delivered_as == DeliveredAs::Turn
                    && is_active_run(fold, Some(&delivered.run_id))
                {
                    fold.active_run_reached_engine = true;
                }
            }
            // Declined: stays queued (a declined steer becomes a followup, same inputId).
            // Refused (GOAT never owned the native turn): fails closed, leaves the queue.
            DeliveryOutcome::Refused => {
                fold.queued_inputs
                    .retain(|q| q.input_id != delivered.input_id);
                fold.active_run_input_ids
                    .retain(|id| id != &delivered.input_id);
            }
            DeliveryOutcome::Declined => {
                fold.active_run_input_ids
                    .retain(|id| id != &delivered.input_id);
            }
            // Unknown: moves into the active run's hold.
            DeliveryOutcome::Unknown => {
                if let Some(index) = fold
                    .queued_inputs
                    .iter()
                    .position(|q| q.input_id == delivered.input_id)
                {
                    let input = fold.queued_inputs.remove(index);
                    hold(fold, &delivered.run_id, vec![input]);
                }
                fold.active_run_input_ids
                    .retain(|id| id != &delivered.input_id);
            }
        },
        LogEvent::RunStarted(started) => {
            fold.counters.runs += 1;
            fold.active_run_id = Some(started.run_id.clone());
            fold.active_run_input_ids = started.input_ids.clone();
            fold.active_run_reached_engine = false;
            if let Some(engine_ref) = &started.engine_ref {
                card.engine_ref = Some(engine_ref.clone());
            }
        }
        LogEvent::RunAccepted(accepted) => {
            if is_active_run(fold, Some(&accepted.run_id)) {
                fold.active_run_reached_engine = true;
            }
        }
        LogEvent::ItemCompleted(done) => {
            fold.counters.items += 1;
            if is_active_run(fold, Some(&done.run_id)) {
                fold.active_run_reached_engine = true;
            }
            if let TurnItemBody::AssistantMessage { phase, text, .. } = &done.item.body
                && !matches!(phase, Some(AssistantMessagePhase::Commentary))
                && !text.trim().is_empty()
            {
                card.latest_answer_excerpt = clamp_chars(text.trim(), CARD_EXCERPT_MAX_CHARS);
            }
        }
        LogEvent::RequestOpened(opened) => {
            if is_active_run(fold, opened.run_id.as_ref()) {
                fold.active_run_reached_engine = true;
            }
            if !fold
                .open_requests
                .iter()
                .any(|r| r.request_id == opened.request_id)
            {
                fold.open_requests.push(opened.clone());
            }
        }
        LogEvent::RequestResolved(resolved) => {
            fold.open_requests
                .retain(|r| r.request_id != resolved.request_id);
            if let Some(index) = fold
                .held_inputs
                .iter()
                .position(|h| h.request_id == resolved.request_id)
            {
                let held = fold.held_inputs.remove(index);
                if resolved.outcome == RequestOutcome::Resend {
                    for (i, input) in held.inputs.into_iter().enumerate() {
                        fold.queued_inputs.insert(i, input);
                    }
                }
            }
        }
        LogEvent::RunFinished(finished) => {
            if is_active_run(fold, Some(&finished.run_id)) {
                let run_inputs = std::mem::take(&mut fold.active_run_input_ids);
                let still_queued: Vec<QueuedInput> = fold
                    .queued_inputs
                    .iter()
                    .filter(|q| run_inputs.contains(&q.input_id))
                    .cloned()
                    .collect();
                if fold.active_run_reached_engine {
                    fold.queued_inputs
                        .retain(|q| !run_inputs.contains(&q.input_id));
                } else if finished.outcome == RunOutcome::Unknown {
                    fold.queued_inputs
                        .retain(|q| !run_inputs.contains(&q.input_id));
                    hold(fold, &finished.run_id, still_queued);
                }
                fold.active_run_id = None;
                fold.active_run_reached_engine = false;
            }
            fold.last_run_outcome = Some(finished.outcome);
        }
        LogEvent::ChildStarted(started) => {
            card.children.total += 1;
            if !fold.running_child_ids.contains(&started.child_thread_id) {
                fold.running_child_ids.push(started.child_thread_id.clone());
            }
        }
        LogEvent::ChildReported(reported) => {
            fold.running_child_ids
                .retain(|id| id != &reported.child_thread_id);
        }
        LogEvent::UserNotified(notified) => {
            if notified.kind == NotifyKind::Result && !notified.text.trim().is_empty() {
                card.latest_answer_excerpt =
                    clamp_chars(notified.text.trim(), CARD_EXCERPT_MAX_CHARS);
            }
        }
    }
    cf.card.updated_at = line.at.clone();
    cf.card.applied_seq = line.seq;
    cf.recompute_status();
}

fn hold(fold: &mut Fold, run_id: &goat2_contracts::RunId, inputs: Vec<QueuedInput>) {
    let request_id = resend_request_id(run_id);
    match fold
        .held_inputs
        .iter_mut()
        .find(|h| h.request_id == request_id)
    {
        Some(held) => {
            for input in inputs {
                if !held.inputs.iter().any(|q| q.input_id == input.input_id) {
                    held.inputs.push(input);
                }
            }
        }
        None if !inputs.is_empty() => fold.held_inputs.push(HeldInputs {
            request_id,
            run_id: run_id.clone(),
            inputs,
        }),
        None => {}
    }
}
