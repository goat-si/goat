//! Decisions an agent reads and answers over MCP (`decision.list`, `decision.read`,
//! `decision.answer`): the open requests of the calling thread and of the worker threads it
//! started, as v1 inbox rows (`DecisionItem`). Opening one is `goat_ask` ([super::asks]).
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc1b2) `packages/contracts/src/agentSurface/
//! entries/decision.ts` (paths, names, guide text, a reason with every answer, silence never
//! approves) and `packages/contracts/src/decisions.ts` via lane C's `DecisionItem`: ids
//! `decision:<thread>:<request>` for a durable decision and `pending:<thread>:<request>` for a
//! projected question; a provider approval needs a person (humanRequired). Not carried in Part 2:
//! remote hosts, permission profiles, expiry (GOAT 2 records none yet), escalation and parent
//! routing (a worker's question reaches the person's inbox at once; its parent bot sees it here
//! and may answer it).

use goat2_contracts::{
    DecisionFrom, DecisionItem, DecisionPending, DecisionPendingApproval, DecisionRoute,
    DecisionSource, DecisionStatus, LogEvent, RequestId, RequestKind, RequestOpened,
    RequestOutcome, ThreadCard, ThreadId, TurnItemBody,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{Caller, ErrorCode, SurfaceResult};
use crate::core::Host;
use crate::core::actor::{Msg, Resolution};

/// `decision.list`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionListArgs {
    /// Only `open` items are kept by GOAT 2; answered ones are in the asking thread's log.
    #[serde(default)]
    pub status: Option<DecisionStatus>,
}

/// `decision.read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionReadArgs {
    pub id: String,
}

fn err(code: ErrorCode, reason: &str, message: impl Into<String>) -> SurfaceResult {
    SurfaceResult::err(code, reason, message, false)
}

/// `decision:<thread>:<request>` or `pending:<thread>:<request>`.
pub fn parse_id(id: &str) -> Option<(ThreadId, RequestId)> {
    let rest = id
        .strip_prefix("decision:")
        .or_else(|| id.strip_prefix("pending:"))?;
    let (thread, request) = rest.rsplit_once(':')?;
    (!thread.is_empty() && !request.is_empty())
        .then(|| (ThreadId::new(thread), RequestId::new(request)))
}

/// The threads whose items the caller sees: its own and its workers'.
fn visible(host: &Host, caller: &ThreadId) -> Vec<ThreadCard> {
    host.store()
        .cards()
        .into_iter()
        .filter(|c| &c.id == caller || c.parent.as_ref().is_some_and(|p| &p.thread_id == caller))
        .collect()
}

fn human_required(kind: RequestKind) -> bool {
    matches!(kind, RequestKind::Approval | RequestKind::Signin)
}

/// The open items of one thread.
pub fn items_of(host: &Host, card: &ThreadCard) -> Vec<DecisionItem> {
    let store = host.store();
    let Some(fold) = store.fold(&card.id) else {
        return Vec::new();
    };
    let open: Vec<RequestOpened> = fold
        .open_requests
        .into_iter()
        .filter(|r| r.kind != RequestKind::Resend)
        .collect();
    if open.is_empty() {
        return Vec::new();
    }
    let lines = store.read_after(&card.id, 0).unwrap_or_default();
    let parent_title = card
        .parent
        .as_ref()
        .and_then(|p| store.card(&p.thread_id))
        .map(|c| c.title);
    open.into_iter()
        .map(|r| {
            let at = lines
                .iter()
                .find(|l| matches!(&l.event, LogEvent::RequestOpened(o) if o.request_id == r.request_id))
                .map(|l| l.at.clone())
                .unwrap_or_else(|| card.updated_at.clone());
            let body = r.item_id.as_ref().and_then(|item| {
                lines.iter().rev().find_map(|l| match &l.event {
                    LogEvent::ItemCompleted(done) if &done.item.id == item => Some(done.item.body.clone()),
                    _ => None,
                })
            });
            let (questions, approval, context) = match body {
                Some(TurnItemBody::UserInputRequest { questions, .. }) => {
                    let context = questions
                        .iter()
                        .map(|q| q.question.clone())
                        .collect::<Vec<_>>()
                        .join("\n");
                    (questions, None, context)
                }
                Some(TurnItemBody::ApprovalRequest {
                    request_kind,
                    prompt,
                    ..
                }) => (
                    Vec::new(),
                    Some(DecisionPendingApproval {
                        kind: request_kind,
                        prompt: prompt.clone(),
                    }),
                    prompt.unwrap_or_default(),
                ),
                _ => (Vec::new(), None, String::new()),
            };
            // What the person needs to know (v1 DecisionItem.context): the ask's own context,
            // else the questions or the approval prompt.
            let context = r.context.clone().filter(|c| !c.trim().is_empty()).unwrap_or(context);
            let durable = r.kind == RequestKind::Decision;
            let id = format!(
                "{}:{}:{}",
                if durable { "decision" } else { "pending" },
                card.id,
                r.request_id
            );
            DecisionItem {
                id,
                source: if durable {
                    DecisionSource::Decision
                } else {
                    DecisionSource::PendingRequest
                },
                from: DecisionFrom {
                    thread_id: Some(card.id.clone()),
                    thread_title: Some(card.title.clone()),
                    parent_thread_id: card.parent.as_ref().map(|p| p.thread_id.clone()),
                    parent_thread_title: parent_title.clone(),
                },
                title: r.summary.clone(),
                context,
                options: r.options.clone().unwrap_or_default(),
                recommended: r.recommended.clone(),
                expires_at: None,
                status: DecisionStatus::Open,
                answer: None,
                answered_by: None,
                answered_by_label: None,
                created_at: at.clone(),
                updated_at: at,
                human_required: human_required(r.kind),
                routed_to: Some(DecisionRoute::Person),
                escalation: None,
                pending: (!durable).then(|| DecisionPending {
                    thread_id: card.id.clone(),
                    request_id: r.request_id.clone(),
                    questions,
                    approval,
                }),
            }
        })
        .collect()
}

pub(crate) async fn list(host: &Host, caller: &Caller, args: DecisionListArgs) -> SurfaceResult {
    if args.status.is_some_and(|s| s != DecisionStatus::Open) {
        return SurfaceResult::ok(json!({ "items": [], "truncated": false }));
    }
    let host2 = host.clone();
    let me = caller.thread_id.clone();
    let items = tokio::task::spawn_blocking(move || {
        visible(&host2, &me)
            .iter()
            .flat_map(|c| items_of(&host2, c))
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    SurfaceResult::ok(json!({ "items": items, "truncated": false }))
}

fn missing(code: ErrorCode, reason: &str, message: &str) -> Box<SurfaceResult> {
    Box::new(err(code, reason, message))
}

fn find(host: &Host, caller: &Caller, id: &str) -> Result<DecisionItem, Box<SurfaceResult>> {
    let Some((thread, _)) = parse_id(id) else {
        return Err(missing(
            ErrorCode::InvalidRequest,
            "invalid_params",
            "not a decision id",
        ));
    };
    let Some(card) = visible(host, &caller.thread_id)
        .into_iter()
        .find(|c| c.id == thread)
    else {
        return Err(missing(
            ErrorCode::NotFound,
            "decision_not_found",
            "no such decision here",
        ));
    };
    items_of(host, &card)
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| {
            missing(
                ErrorCode::NotFound,
                "decision_not_found",
                "the decision is not open",
            )
        })
}

pub(crate) async fn read(host: &Host, caller: &Caller, args: DecisionReadArgs) -> SurfaceResult {
    match find(host, caller, &args.id) {
        Ok(item) => SurfaceResult::ok(json!({ "item": item })),
        Err(e) => *e,
    }
}

pub(crate) async fn answer(
    host: &Host,
    caller: &Caller,
    args: goat2_contracts::DecisionAnswerInput,
) -> SurfaceResult {
    let item = match find(host, caller, &args.id) {
        Ok(item) => item,
        Err(e) => return *e,
    };
    let (thread, request) = parse_id(&item.id).expect("listed id");
    if thread == caller.thread_id {
        return err(
            ErrorCode::PermissionDenied,
            "not_allowed",
            "the asking thread cannot answer its own question; the person or its parent does",
        );
    }
    if item.human_required {
        return err(
            ErrorCode::PermissionDenied,
            "human_required",
            "an approval or sign-in needs the person; it stays in their inbox",
        );
    }
    let resolution = match item.source {
        DecisionSource::Decision => {
            let Some(option) = args.option_id.clone() else {
                return err(
                    ErrorCode::InvalidRequest,
                    "invalid_params",
                    "a decision is answered with optionId",
                );
            };
            if !item.options.iter().any(|o| o.id == option) {
                return err(
                    ErrorCode::InvalidRequest,
                    "invalid_params",
                    "optionId is not one of the options",
                );
            }
            Resolution {
                request_id: request,
                outcome: RequestOutcome::Decided,
                option_id: Some(option),
                text: Some(args.reason.clone()),
                answers: None,
            }
        }
        DecisionSource::PendingRequest => {
            let Some(answers) = args.answers.clone() else {
                return err(
                    ErrorCode::InvalidRequest,
                    "invalid_params",
                    "a question is answered with answers {questionId: answer}",
                );
            };
            Resolution {
                request_id: request,
                outcome: RequestOutcome::Answered,
                option_id: None,
                text: Some(args.reason.clone()),
                answers: Some(answers),
            }
        }
    };
    match crate::core::commands::ask(host, &thread, |tx| Msg::Resolve(resolution, tx)).await {
        Ok(()) => SurfaceResult::ok(json!({ "id": item.id, "status": "answered" })),
        Err(r) => err(ErrorCode::FailedPrecondition, r.code.as_str(), r.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert_eq!(
            parse_id("pending:thr_1:ask_2"),
            Some((ThreadId::new("thr_1"), RequestId::new("ask_2")))
        );
        assert_eq!(parse_id("decision:thr_1:"), None);
        assert_eq!(parse_id("other:thr_1:x"), None);
    }
}
