//! The 11 Part 1 MCP paths' effects ([McpHost] for [Host]). Authority comes from the caller
//! (token -> thread -> active run): a thread may only send to, read, wait on and stop its own
//! children; a worker may not start children (depth 1); a parent runs at most 4 children.

use std::time::Duration;

use async_trait::async_trait;
use goat2_contracts::limits::{BLOB_THRESHOLD_BYTES, NEEDS_YOU_SUMMARY_MAX_CHARS};
use goat2_contracts::text::clamp_chars;
use goat2_contracts::{
    ChildStarted, EngineConfig, InputSource, ItemId, LogEvent, ParentRef, RequestId, RequestKind,
    RequestOpened, StartMode, ThreadCard, ThreadId, ThreadKind, UserNotified,
};
use serde_json::json;

use super::actor::{InputAck, Msg, NewInput};
use super::commands::{NewThread, ask, create_thread};
use super::{ChildOutcome, Host};
use crate::api::{
    AskKind, Caller, ErrorCode, Handoff, McpGrant, McpHost, ReportResultArgs, RequestAskArgs,
    SurfaceError, SurfaceResult, ThreadListArgs, ThreadReadArgs, ThreadSendArgs, ThreadStartArgs,
    ThreadStopArgs, ThreadWaitArgs, UserSendArgs,
};
use crate::util::new_id;

fn err(code: ErrorCode, reason: &str, message: impl Into<String>) -> SurfaceResult {
    SurfaceResult::err(code, reason, message, false)
}

fn internal(e: impl std::fmt::Display) -> SurfaceResult {
    err(ErrorCode::Internal, "internal", e.to_string())
}

fn outcome_json(o: &ChildOutcome) -> serde_json::Value {
    json!({
        "childThreadId": o.child_thread_id,
        "childRunId": o.child_run_id,
        "status": o.status,
        "summary": o.summary,
        "cursor": o.cursor,
    })
}

fn card_json(card: &ThreadCard) -> serde_json::Value {
    json!({
        "threadId": card.id,
        "title": card.title,
        "status": card.status,
        "lastExcerpt": card.last_excerpt,
        "needsYou": card.needs_you,
        "updatedAt": card.updated_at,
        "link": format!("[{}](goat-thread://v1/{})", card.title, card.id),
    })
}

impl Host {
    /// The caller's own child, or a refusal.
    fn own_child(
        &self,
        caller: &Caller,
        child: &ThreadId,
    ) -> Result<ThreadCard, Box<SurfaceResult>> {
        let card = self.inner.store.card(child).ok_or_else(|| {
            Box::new(err(
                ErrorCode::NotFound,
                "thread_not_found",
                format!("no thread {child}"),
            ))
        })?;
        if card.parent.as_ref().map(|p| &p.thread_id) != Some(&caller.thread_id) {
            return Err(Box::new(err(
                ErrorCode::PermissionDenied,
                "not_your_child",
                "a thread may only act on its own children",
            )));
        }
        Ok(card)
    }

    async fn wait_child(
        &self,
        caller: &Caller,
        child: &ThreadId,
        timeout_ms: Option<u64>,
    ) -> SurfaceResult {
        let max = self.inner.opts.max_wait;
        let timeout = timeout_ms.map_or(max, |ms| Duration::from_millis(ms).min(max));
        let rx = self.add_waiter(child, caller.run_id.clone());
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => SurfaceResult::ok(
                json!({ "released": "completed", "result": outcome_json(&outcome) }),
            ),
            Ok(Err(_)) => {
                SurfaceResult::ok(json!({ "released": "cancelled", "childThreadId": child }))
            }
            Err(_) => SurfaceResult::ok(json!({
                "released": "timeout",
                "waitTimedOut": true,
                "childThreadId": child,
                "next": "Do not poll: the child's result wakes this thread when it finishes.",
            })),
        }
    }
}

#[async_trait]
impl McpHost for Host {
    fn grant(&self, token: &str) -> Option<McpGrant> {
        let tokens = self.inner.tokens.lock().expect("tokens");
        tokens
            .iter()
            .find(|(t, _)| crate::util::token_eq(t, token))
            .map(|(_, g)| g.clone())
    }

    async fn caller(&self, grant: &McpGrant) -> Result<Caller, SurfaceError> {
        if grant.host_generation != self.inner.opts.host_generation {
            return Err(SurfaceError::new(
                ErrorCode::Unauthenticated,
                "stale_host_generation",
                "token from an older host start",
                false,
            ));
        }
        let rt = self.runtime_of(&grant.thread_id).unwrap_or_default();
        if rt.process_generation != grant.process_generation || !rt.session_alive {
            return Err(SurfaceError::new(
                ErrorCode::Unauthenticated,
                "stale_process_generation",
                "token from an older engine process of this thread",
                false,
            ));
        }
        let Some(run_id) = rt.active_run else {
            return Err(SurfaceError::new(
                ErrorCode::FailedPrecondition,
                "no_active_run",
                "no run is active in this thread, so nothing was written",
                false,
            ));
        };
        Ok(Caller {
            thread_id: grant.thread_id.clone(),
            run_id,
            kind: rt.kind.unwrap_or(ThreadKind::User),
        })
    }

    async fn thread_start(&self, caller: &Caller, args: ThreadStartArgs) -> SurfaceResult {
        if caller.kind == ThreadKind::Worker {
            return err(
                ErrorCode::PermissionDenied,
                "depth_limit",
                "a worker thread cannot start children (depth 1)",
            );
        }
        if args.task.trim().is_empty() {
            return err(ErrorCode::InvalidRequest, "invalid_params", "task is empty");
        }
        if args.task.len() > BLOB_THRESHOLD_BYTES {
            return err(
                ErrorCode::InvalidRequest,
                "payload_too_large",
                "task is larger than 64 KB",
            );
        }
        if self.busy_children(&caller.thread_id) >= self.inner.opts.max_children {
            return SurfaceResult::err(
                ErrorCode::ResourceExhausted,
                "child_budget",
                format!(
                    "this thread already runs {} children; wait for one to finish",
                    self.inner.opts.max_children
                ),
                true,
            );
        }
        let Some(parent) = self.inner.store.card(&caller.thread_id) else {
            return internal("caller thread missing");
        };
        let by_item_id = ItemId::new(format!(
            "mcp:{}:thread.start:{}",
            caller.run_id,
            args.client_request_id
                .clone()
                .unwrap_or_else(|| new_id("call"))
        ));
        let title = args
            .title
            .clone()
            .unwrap_or_else(|| clamp_chars(args.task.lines().next().unwrap_or("Task").trim(), 80));
        let child = match create_thread(
            self,
            NewThread {
                kind: ThreadKind::Worker,
                title,
                bot_id: parent.bot_id.clone(),
                parent: Some(ParentRef {
                    thread_id: caller.thread_id.clone(),
                    by_item_id: by_item_id.clone(),
                }),
                engine: EngineConfig {
                    driver: parent.engine.driver,
                    model: args
                        .model
                        .clone()
                        .unwrap_or_else(|| parent.engine.model.clone()),
                    runtime_mode: parent.engine.runtime_mode.clone(),
                    cwd: args
                        .cwd
                        .clone()
                        .unwrap_or_else(|| parent.engine.cwd.clone()),
                },
            },
        ) {
            Ok(card) => card,
            Err(e) => return internal(e),
        };
        if let Err(e) = self.append(
            &caller.thread_id,
            vec![LogEvent::ChildStarted(ChildStarted {
                child_thread_id: child.id.clone(),
                task: args.task.clone(),
                by_item_id,
            })],
        ) {
            return internal(e);
        }
        let wait = args.mode == Some(StartMode::Wait);
        // Register the waiter before the child can finish.
        let rx = wait.then(|| self.add_waiter(&child.id, caller.run_id.clone()));
        let input = NewInput {
            from: InputSource::System,
            text: args.task,
            attachments: Vec::new(),
            mode: None,
            client_request_id: format!("mcp:{}:start", child.id),
        };
        if let Err(r) = ask(self, &child.id, |tx| Msg::Input(input, tx)).await {
            return internal(r.message);
        }
        let started = json!({
            "childThreadId": child.id,
            "title": child.title,
            "mode": if wait { "wait" } else { "async" },
            "link": format!("[{}](goat-thread://v1/{})", child.title, child.id),
        });
        let Some(rx) = rx else {
            return SurfaceResult::ok(json!({
                "started": started,
                "next": "The child's result wakes this thread when it finishes; do not poll.",
            }));
        };
        let max = self.inner.opts.max_wait;
        let timeout = args
            .timeout_ms
            .map_or(max, |ms| Duration::from_millis(ms).min(max));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => SurfaceResult::ok(
                json!({ "started": started, "released": "completed", "result": outcome_json(&outcome) }),
            ),
            Ok(Err(_)) => SurfaceResult::ok(json!({ "started": started, "released": "cancelled" })),
            Err(_) => SurfaceResult::ok(
                json!({ "started": started, "released": "timeout", "waitTimedOut": true }),
            ),
        }
    }

    async fn thread_send(&self, caller: &Caller, args: ThreadSendArgs) -> SurfaceResult {
        let child = match self.own_child(caller, &args.thread_id) {
            Ok(c) => c,
            Err(e) => return *e,
        };
        if args.text.len() > BLOB_THRESHOLD_BYTES {
            return err(
                ErrorCode::InvalidRequest,
                "payload_too_large",
                "text is larger than 64 KB",
            );
        }
        let child_busy = self.runtime_of(&child.id).is_some_and(|rt| rt.busy);
        if !child_busy && self.busy_children(&caller.thread_id) >= self.inner.opts.max_children {
            return SurfaceResult::err(
                ErrorCode::ResourceExhausted,
                "child_budget",
                "this thread already runs 4 children",
                true,
            );
        }
        let input = NewInput {
            from: InputSource::System,
            text: args.text,
            attachments: Vec::new(),
            mode: args.mode,
            client_request_id: format!(
                "mcp:{}:send:{}",
                caller.run_id,
                args.client_request_id.unwrap_or_else(|| new_id("call"))
            ),
        };
        match ask(self, &child.id, |tx| Msg::Input(input, tx)).await {
            Ok(InputAck { input_id, run_id }) => SurfaceResult::ok(json!({
                "threadId": child.id,
                "inputId": input_id,
                "steeredInto": run_id,
            })),
            Err(r) => err(ErrorCode::Conflict, "thread_not_sendable", r.message),
        }
    }

    async fn thread_read(&self, caller: &Caller, args: ThreadReadArgs) -> SurfaceResult {
        let card = match self.own_child(caller, &args.thread_id) {
            Ok(c) => c,
            Err(e) => return *e,
        };
        let limit = args.limit.unwrap_or(20).clamp(1, 100) as usize;
        let before = args.before.unwrap_or(u64::MAX);
        let store = self.inner.store.clone();
        let id = card.id.clone();
        let page = tokio::task::spawn_blocking(move || store.read_page(&id, before, limit)).await;
        match page {
            Ok(Ok((lines, has_more))) => {
                let next_before = lines.first().map(|l| l.seq);
                SurfaceResult::ok(json!({
                    "card": card_json(&card),
                    "lines": lines,
                    "hasMore": has_more,
                    "nextBefore": if has_more { next_before } else { None },
                }))
            }
            Ok(Err(e)) => internal(e),
            Err(e) => internal(e),
        }
    }

    async fn thread_list(&self, caller: &Caller, args: ThreadListArgs) -> SurfaceResult {
        let include_finished = args.include_finished.unwrap_or(true);
        let children: Vec<_> = self
            .inner
            .store
            .cards()
            .into_iter()
            .filter(|c| c.parent.as_ref().map(|p| &p.thread_id) == Some(&caller.thread_id))
            .filter(|c| include_finished || self.runtime_of(&c.id).is_some_and(|rt| rt.busy))
            .map(|c| card_json(&c))
            .collect();
        SurfaceResult::ok(
            json!({ "children": children, "running": self.busy_children(&caller.thread_id) }),
        )
    }

    async fn thread_wait(&self, caller: &Caller, args: ThreadWaitArgs) -> SurfaceResult {
        let card = match self.own_child(caller, &args.thread_id) {
            Ok(c) => c,
            Err(e) => return *e,
        };
        if !self.runtime_of(&card.id).is_some_and(|rt| rt.busy) {
            return SurfaceResult::ok(json!({ "released": "idle", "card": card_json(&card) }));
        }
        self.wait_child(caller, &card.id, args.timeout_ms).await
    }

    async fn thread_stop(&self, caller: &Caller, args: ThreadStopArgs) -> SurfaceResult {
        let card = match self.own_child(caller, &args.thread_id) {
            Ok(c) => c,
            Err(e) => return *e,
        };
        match ask(self, &card.id, |tx| Msg::Stop {
            hold: false,
            reply: Some(tx),
        })
        .await
        {
            Ok(run) => SurfaceResult::ok(json!({ "threadId": card.id, "stoppedRunId": run })),
            Err(r) => internal(r.message),
        }
    }

    async fn report_result(&self, caller: &Caller, args: ReportResultArgs) -> SurfaceResult {
        if caller.kind != ThreadKind::Worker {
            return err(
                ErrorCode::FailedPrecondition,
                "not_a_worker",
                "only a worker thread reports a result to its parent",
            );
        }
        let summary = goat2_contracts::text::clamp_bytes(
            &args.summary,
            goat2_contracts::limits::CHILD_SUMMARY_MAX_BYTES,
        );
        self.runtime_update(&caller.thread_id, |rt| {
            rt.report = Some((args.outcome, summary))
        });
        SurfaceResult::ok(
            json!({ "recorded": true, "next": "The parent receives it when this run ends." }),
        )
    }

    async fn user_send(&self, caller: &Caller, args: UserSendArgs) -> SurfaceResult {
        let mut first = false;
        self.runtime_update(&caller.thread_id, |rt| {
            first = rt.notified.insert(args.kind)
        });
        if !first {
            return err(
                ErrorCode::Conflict,
                "already_sent",
                "this run already sent that kind of message",
            );
        }
        match self.append(
            &caller.thread_id,
            vec![LogEvent::UserNotified(UserNotified {
                run_id: Some(caller.run_id.clone()),
                kind: args.kind,
                text: args.text,
            })],
        ) {
            Ok(_) => SurfaceResult::ok(json!({ "sent": true })),
            Err(e) => internal(e),
        }
    }

    async fn request_ask(&self, caller: &Caller, args: RequestAskArgs) -> SurfaceResult {
        let kind = match args.kind {
            AskKind::Question => RequestKind::Question,
            AskKind::Approval => RequestKind::Approval,
            AskKind::Decision => RequestKind::Decision,
        };
        if kind == RequestKind::Decision && args.options.len() < 2 {
            return err(
                ErrorCode::InvalidRequest,
                "invalid_params",
                "a decision needs at least two options",
            );
        }
        let request_id = RequestId::new(new_id("req"));
        let summary = clamp_chars(&args.summary, NEEDS_YOU_SUMMARY_MAX_CHARS);
        let opened = RequestOpened {
            request_id: request_id.clone(),
            run_id: Some(caller.run_id.clone()),
            item_id: None,
            kind,
            summary: summary.clone(),
            options: (kind == RequestKind::Decision).then(|| args.options.clone()),
            recommended: None,
        };
        if let Err(e) = self.append(&caller.thread_id, vec![LogEvent::RequestOpened(opened)]) {
            return internal(e);
        }
        SurfaceResult::NeedsHuman {
            handoff: Handoff {
                handoff_id: request_id.to_string(),
                kind: format!("{kind:?}").to_lowercase(),
                title: summary,
                state: "open".to_owned(),
                expires_at: None,
                target_path: "request.ask".to_owned(),
            },
            next: None,
        }
    }
}
