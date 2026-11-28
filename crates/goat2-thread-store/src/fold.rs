//! The card fold: how each log line changes the card and the contract [Fold].
//!
//! The fold is total: it never fails, so any valid log can be replayed. The store validates events
//! before it appends them (see `Store::append`).

use crate::contract::*;

/// Request id of the resend request for an unknown run.
pub fn resend_request_id(run: &RunId) -> RequestId {
    RequestId::new(format!("resend:{}", run.as_str()))
}

/// Card and fold right after `thread.created` (seq 1).
pub fn initial(
    id: &ThreadId,
    created: &ThreadCreated,
    epoch: &Epoch,
    seq: u64,
    at: &str,
) -> (ThreadCard, Fold) {
    let card = ThreadCard {
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
        updated_at: at.to_owned(),
        epoch: epoch.clone(),
        applied_seq: seq,
        card_seq: 0,
        open_asks: 0,
        unread: false,
    };
    (card, Fold::default())
}

fn take_queued(fold: &mut Fold, id: &InputId) -> Option<QueuedInput> {
    let pos = fold.queued_inputs.iter().position(|q| &q.input_id == id)?;
    Some(fold.queued_inputs.remove(pos))
}

/// Index of the hold for `run`, creating it and its `resend` request if needed.
fn ensure_resend(fold: &mut Fold, run: &RunId) -> usize {
    let request_id = resend_request_id(run);
    if !fold
        .open_requests
        .iter()
        .any(|r| r.request_id == request_id)
    {
        fold.open_requests.push(RequestOpened {
            request_id: request_id.clone(),
            run_id: Some(run.clone()),
            item_id: None,
            kind: RequestKind::Resend,
            summary: clamp_chars(
                &format!("Run {run} may not have reached the engine. Resend or drop it."),
                NEEDS_YOU_SUMMARY_MAX_CHARS,
            ),
            options: None,
            recommended: None,
            context: None,
        });
    }
    if let Some(i) = fold.held_inputs.iter().position(|h| &h.run_id == run) {
        return i;
    }
    fold.held_inputs.push(HeldInputs {
        request_id,
        run_id: run.clone(),
        inputs: Vec::new(),
    });
    fold.held_inputs.len() - 1
}

fn is_active(fold: &Fold, run: &RunId) -> bool {
    fold.active_run_id.as_ref() == Some(run)
}

/// Apply one line. `thread.created` after seq 1 and `checkpoint` lines change nothing but
/// `appliedSeq` / `updatedAt`: the store never restores its own state from a checkpoint.
pub fn apply(card: &mut ThreadCard, fold: &mut Fold, line: &LogLine) {
    match &line.event {
        LogEvent::ThreadCreated(_) | LogEvent::Checkpoint(_) => {}
        LogEvent::ThreadChanged(e) => {
            if let Some(title) = &e.title {
                card.title = clamp_chars(title, CARD_TITLE_MAX_CHARS);
            }
            if let Some(selection) = &e.model_selection {
                card.engine.model_selection = selection.clone();
            }
            if let Some(mode) = e.runtime_mode {
                card.engine.runtime_mode = mode;
            }
            if let Some(mode) = e.follow_up_mode {
                card.follow_up_mode = mode;
            }
            if let Some(archived_at) = &e.archived_at {
                card.archived_at = archived_at.clone();
            }
        }
        LogEvent::InputAccepted(e) => {
            fold.counters.inputs += 1;
            let known = fold.queued_inputs.iter().any(|q| q.input_id == e.input_id)
                || fold
                    .held_inputs
                    .iter()
                    .any(|h| h.inputs.iter().any(|q| q.input_id == e.input_id));
            if !known {
                fold.queued_inputs.push(QueuedInput {
                    input_id: e.input_id.clone(),
                    text: e.text.clone(),
                    mode: e.mode,
                    source: e.from.clone(),
                    attachments: e.attachments.clone(),
                });
            }
        }
        LogEvent::InputChanged(e) => {
            if e.cancelled == Some(true) {
                take_queued(fold, &e.input_id);
            } else if let Some(pos) = fold
                .queued_inputs
                .iter()
                .position(|q| q.input_id == e.input_id)
            {
                if let Some(text) = &e.text {
                    fold.queued_inputs[pos].text = text.clone();
                }
                if let Some(mode) = e.mode {
                    fold.queued_inputs[pos].mode = mode;
                }
                if let Some(to) = e.position {
                    let item = fold.queued_inputs.remove(pos);
                    let to = (to as usize).min(fold.queued_inputs.len());
                    fold.queued_inputs.insert(to, item);
                }
            }
        }
        LogEvent::InputDelivered(e) => match e.outcome {
            DeliveryOutcome::Accepted => {
                take_queued(fold, &e.input_id);
                if e.delivered_as == DeliveredAs::Turn && is_active(fold, &e.run_id) {
                    fold.active_run_reached_engine = true;
                }
            }
            DeliveryOutcome::Declined => {
                fold.active_run_input_ids.retain(|id| id != &e.input_id);
            }
            DeliveryOutcome::Refused => {
                // Fails closed: the input leaves the queue and is never retried.
                fold.active_run_input_ids.retain(|id| id != &e.input_id);
                take_queued(fold, &e.input_id);
            }
            DeliveryOutcome::Unknown => {
                fold.active_run_input_ids.retain(|id| id != &e.input_id);
                if let Some(input) = take_queued(fold, &e.input_id) {
                    let i = ensure_resend(fold, &e.run_id);
                    fold.held_inputs[i].inputs.push(input);
                }
            }
        },
        LogEvent::RunStarted(e) => {
            fold.active_run_id = Some(e.run_id.clone());
            fold.active_run_input_ids = e.input_ids.clone();
            fold.active_run_reached_engine = false;
            fold.counters.runs += 1;
            if let Some(engine_ref) = &e.engine_ref {
                card.engine_ref = Some(engine_ref.clone());
            }
        }
        LogEvent::RunAccepted(e) => {
            if is_active(fold, &e.run_id) {
                fold.active_run_reached_engine = true;
            }
        }
        LogEvent::ItemCompleted(e) => {
            fold.counters.items += 1;
            // A late item (its run already finished, e.g. a background subagent) is kept in the
            // log under its origin run but changes neither the restart evidence nor the excerpt,
            // so it cannot replace a newer run's answer.
            if is_active(fold, &e.run_id) {
                fold.active_run_reached_engine = true;
                if let TurnItemBody::AssistantMessage { text, .. } = &e.item.body {
                    card.latest_answer_excerpt = clamp_chars(text, CARD_EXCERPT_MAX_CHARS);
                }
            }
        }
        LogEvent::RequestOpened(e) => {
            if e.run_id.as_ref().is_some_and(|run| is_active(fold, run)) {
                fold.active_run_reached_engine = true;
            }
            if !fold
                .open_requests
                .iter()
                .any(|r| r.request_id == e.request_id)
            {
                fold.open_requests.push(e.clone());
            }
        }
        LogEvent::RequestResolved(e) => {
            fold.open_requests.retain(|r| r.request_id != e.request_id);
            if let Some(i) = fold
                .held_inputs
                .iter()
                .position(|h| h.request_id == e.request_id)
            {
                let hold = fold.held_inputs.remove(i);
                if e.outcome == RequestOutcome::Resend {
                    let mut inputs = hold.inputs;
                    inputs.append(&mut fold.queued_inputs);
                    fold.queued_inputs = inputs;
                }
            }
        }
        LogEvent::RunFinished(e) => {
            if is_active(fold, &e.run_id) {
                let run_inputs = std::mem::take(&mut fold.active_run_input_ids);
                if fold.active_run_reached_engine {
                    for id in &run_inputs {
                        take_queued(fold, id);
                    }
                } else if e.outcome == RunOutcome::Unknown {
                    let held: Vec<QueuedInput> = run_inputs
                        .iter()
                        .filter_map(|id| take_queued(fold, id))
                        .collect();
                    let i = ensure_resend(fold, &e.run_id);
                    fold.held_inputs[i].inputs.extend(held);
                }
                if e.outcome == RunOutcome::Unknown {
                    ensure_resend(fold, &e.run_id);
                }
                fold.active_run_id = None;
                fold.active_run_reached_engine = false;
                fold.last_run_outcome = Some(e.outcome);
            }
        }
        LogEvent::ChildStarted(e) => {
            if !fold.running_child_ids.contains(&e.child_thread_id) {
                fold.running_child_ids.push(e.child_thread_id.clone());
                card.children.total += 1;
            }
        }
        LogEvent::ChildReported(e) => {
            fold.running_child_ids.retain(|id| id != &e.child_thread_id);
        }
        LogEvent::UserNotified(e) => {
            card.latest_answer_excerpt = clamp_chars(&e.text, CARD_EXCERPT_MAX_CHARS);
        }
    }
    card.applied_seq = line.seq;
    card.updated_at = line.at.clone();
    refresh_status(card, fold);
}

/// Card status precedence (structure/20_data.md): open request (incl. an unresolved unknown run,
/// kind `resend`) -> needs_you; active run -> running; queued inputs -> queued; last run failed ->
/// failed; else idle.
pub fn refresh_status(card: &mut ThreadCard, fold: &Fold) {
    card.children.running = fold.running_child_ids.len() as u32;
    // Questions that need a person: every open request except the store's own `resend` holds.
    card.open_asks = fold
        .open_requests
        .iter()
        .filter(|r| r.kind != RequestKind::Resend)
        .count() as u32;
    if let Some(request) = fold.open_requests.last() {
        card.status = ThreadStatus::NeedsYou;
        card.needs_you = Some(NeedsYou {
            kind: request.kind,
            summary: clamp_chars(&request.summary, NEEDS_YOU_SUMMARY_MAX_CHARS),
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
