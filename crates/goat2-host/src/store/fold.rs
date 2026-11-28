//! Card fold: `goat.jsonl` lines -> [ThreadCard] + [Fold].

use goat2_contracts::limits::CARD_EXCERPT_MAX_CHARS;
use goat2_contracts::text::clamp_chars;
use goat2_contracts::{
    AssistantMessagePhase, ChildCounts, DeliveredAs, DeliveryOutcome, Epoch, Fold, LogEvent,
    LogLine, NeedsYou, NotifyKind, RunOutcome, ThreadCard, ThreadId, ThreadStatus, TurnItemBody,
};

/// Card plus the fold state, and the one bit the status precedence needs that neither carries:
/// whether the last finished run failed.
#[derive(Debug, Clone, PartialEq)]
pub struct CardFold {
    pub card: ThreadCard,
    pub fold: Fold,
    pub last_run_failed: bool,
}

impl CardFold {
    /// Rebuild from a stored card and fold (`card.json`).
    pub fn from_stored(card: ThreadCard, fold: Fold) -> Self {
        let last_run_failed = card.status == ThreadStatus::Failed;
        Self {
            card,
            fold,
            last_run_failed,
        }
    }

    /// Recompute `status` and `needsYou` with the precedence from PRD model.md:
    /// open request (incl. resend) > running > queued > failed > idle.
    pub fn recompute_status(&mut self) {
        let card = &mut self.card;
        if let Some(request) = self.fold.open_requests.last() {
            card.status = ThreadStatus::NeedsYou;
            card.needs_you = Some(NeedsYou {
                kind: request.kind,
                summary: request.summary.clone(),
            });
            return;
        }
        card.needs_you = None;
        card.status = if self.fold.active_run_id.is_some() {
            ThreadStatus::Running
        } else if !self.fold.queued_input_ids.is_empty() {
            ThreadStatus::Queued
        } else if self.last_run_failed {
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
            title: clamp_chars(
                &created.title,
                goat2_contracts::limits::CARD_TITLE_MAX_CHARS,
            ),
            project_id: created.project_id.clone(),
            bot_id: created.bot_id.clone(),
            parent: created.parent.clone(),
            engine: created.engine.clone(),
            engine_ref: None,
            status: ThreadStatus::Idle,
            needs_you: None,
            last_excerpt: String::new(),
            children: ChildCounts::default(),
            follow_up_mode: created.follow_up_mode,
            archived: false,
            updated_at: line.at.clone(),
            epoch,
            applied_seq: line.seq,
            card_seq: 0,
        },
        fold: Fold::default(),
        last_run_failed: false,
    };
    cf.recompute_status();
    Some(cf)
}

/// Apply one line after `thread.created`.
pub fn fold_line(cf: &mut CardFold, line: &LogLine) {
    let card = &mut cf.card;
    let fold = &mut cf.fold;
    match &line.event {
        LogEvent::ThreadCreated(_) | LogEvent::RunAccepted(_) | LogEvent::Checkpoint(_) => {}
        LogEvent::ThreadChanged(change) => {
            if let Some(title) = &change.title {
                card.title = clamp_chars(title, goat2_contracts::limits::CARD_TITLE_MAX_CHARS);
            }
            if let Some(model) = &change.model {
                card.engine.model = model.clone();
            }
            if let Some(mode) = &change.runtime_mode {
                card.engine.runtime_mode = mode.clone();
            }
            if let Some(mode) = change.follow_up_mode {
                card.follow_up_mode = mode;
            }
            if let Some(archived) = change.archived {
                card.archived = archived;
            }
        }
        LogEvent::InputAccepted(input) => {
            fold.counters.inputs += 1;
            if !fold.queued_input_ids.contains(&input.input_id) {
                fold.queued_input_ids.push(input.input_id.clone());
            }
        }
        LogEvent::InputDelivered(delivered) => match (delivered.delivered_as, delivered.outcome) {
            // A declined steer stays queued as a followup with the same inputId.
            (DeliveredAs::Steer, DeliveryOutcome::Declined) => {
                if !fold.queued_input_ids.contains(&delivered.input_id) {
                    fold.queued_input_ids.push(delivered.input_id.clone());
                }
            }
            _ => fold.queued_input_ids.retain(|id| id != &delivered.input_id),
        },
        LogEvent::RunStarted(started) => {
            fold.counters.runs += 1;
            fold.active_run_id = Some(started.run_id.clone());
            fold.queued_input_ids
                .retain(|id| !started.input_ids.contains(id));
            if let Some(engine_ref) = &started.engine_ref {
                card.engine_ref = Some(engine_ref.clone());
            }
            cf.last_run_failed = false;
        }
        LogEvent::ItemCompleted(done) => {
            fold.counters.items += 1;
            if let TurnItemBody::AssistantMessage { phase, text, .. } = &done.item.body
                && !matches!(phase, Some(AssistantMessagePhase::Commentary))
                && !text.trim().is_empty()
            {
                card.last_excerpt = clamp_chars(text.trim(), CARD_EXCERPT_MAX_CHARS);
            }
        }
        LogEvent::RequestOpened(opened) => {
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
        }
        LogEvent::RunFinished(finished) => {
            if fold.active_run_id.as_ref() == Some(&finished.run_id) {
                fold.active_run_id = None;
            }
            cf.last_run_failed = finished.outcome == RunOutcome::Failed;
        }
        LogEvent::ChildStarted(_) => {
            card.children.total += 1;
            card.children.running += 1;
        }
        LogEvent::ChildReported(_) => {
            card.children.running = card.children.running.saturating_sub(1);
        }
        LogEvent::UserNotified(notified) => {
            if notified.kind == NotifyKind::Result && !notified.text.trim().is_empty() {
                card.last_excerpt = clamp_chars(notified.text.trim(), CARD_EXCERPT_MAX_CHARS);
            }
        }
    }
    let card = &mut cf.card;
    card.updated_at = line.at.clone();
    card.applied_seq = line.seq;
    cf.recompute_status();
}
