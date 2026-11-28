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
        "lastExcerpt": card.latest_answer_excerpt,
        "needsYou": card.needs_you,
        "updatedAt": card.updated_at,
        "link": format!("[{}](goat-thread://v1/{})", card.title, card.id),
    })
}

impl Host {
    /// Writes commit only while the caller's run is still the thread's active run (the MCP
    /// layer checks the caller once at admission; this fences a call that outlived its run).
    async fn fence(
        &self,
        caller: &Caller,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, Box<SurfaceResult>> {
        // Held through the commit: the actor ends the run under the same lock.
        let guard = self.fence_lock(&caller.thread_id).lock_owned().await;
        let active = self
            .runtime_of(&caller.thread_id)
            .and_then(|rt| rt.active_run);
        if active.as_ref() != Some(&caller.run_id) {
            return Err(Box::new(err(
                ErrorCode::FailedPrecondition,
                "no_active_run",
                "the calling run has ended, so nothing was written",
            )));
        }
        Ok(guard)
    }

    /// Lend the caller run's slot while it waits on a child (see sched::RunSlot::park).
    fn park_caller(&self, caller: &Caller) -> Option<super::sched::Parked> {
        let rt = self.runtime_of(&caller.thread_id)?;
        if rt.active_run.as_ref() != Some(&caller.run_id) {
            return None;
        }
        rt.run_slot.map(|slot| slot.park())
    }

    /// An earlier input to `thread` with this clientRequestId, from its recent log.
    async fn input_with_key(
        &self,
        thread: &ThreadId,
        key: &str,
    ) -> Option<goat2_contracts::InputId> {
        let store = self.inner.store.clone();
        let (thread, key) = (thread.clone(), key.to_owned());
        tokio::task::spawn_blocking(move || {
            let (lines, _) = store.read_page(&thread, u64::MAX, 512).ok()?;
            lines.into_iter().rev().find_map(|l| match l.event {
                LogEvent::InputAccepted(i) if i.client_request_id == key => Some(i.input_id),
                _ => None,
            })
        })
        .await
        .ok()
        .flatten()
    }

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
        // Register first, then check: a child finishing in between cannot be missed.
        let rx = self.add_waiter(child, caller.run_id.clone());
        if !self.runtime_of(child).is_some_and(|rt| rt.busy) {
            drop(rx);
            self.prune_waiters(child);
            let card = self.inner.store.card(child);
            return SurfaceResult::ok(
                json!({ "released": "idle", "card": card.as_ref().map(card_json) }),
            );
        }
        let parked = self.park_caller(caller);
        let waited = tokio::time::timeout(timeout, rx).await;
        if let Some(parked) = parked {
            parked.resume().await;
        }
        if waited.is_err() {
            self.prune_waiters(child);
        }
        match waited {
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
        let fenced = match self.fence(caller).await {
            Ok(guard) => guard,
            Err(e) => return *e,
        };
        // A key names the child: a retry, also after a host restart, finds the same thread.
        let child_id = args.client_request_id.as_deref().map(|key| {
            ThreadId::new(format!(
                "thr_{}",
                crate::util::stable_id(&[caller.thread_id.as_str(), "thread.start", key])
            ))
        });
        if let Some(existing) = child_id.as_ref().and_then(|id| self.inner.store.card(id)) {
            return SurfaceResult::ok(json!({
                "started": {
                    "childThreadId": existing.id,
                    "title": existing.title,
                    "link": format!("[{}](goat-thread://v1/{})", existing.title, existing.id),
                },
                "deduplicated": true,
            }));
        }
        // Held until the child's first input made it busy, so parallel starts cannot pass the cap.
        let Some(reservation) = self.reserve_child(&caller.thread_id) else {
            return SurfaceResult::err(
                ErrorCode::ResourceExhausted,
                "child_budget",
                format!(
                    "this thread already runs {} children; wait for one to finish",
                    self.inner.opts.max_children
                ),
                true,
            );
        };
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
            child_id,
            NewThread {
                kind: ThreadKind::Worker,
                title,
                bot_id: parent.bot_id.clone(),
                parent: Some(ParentRef {
                    thread_id: caller.thread_id.clone(),
                    by_item_id: by_item_id.clone(),
                }),
                engine: EngineConfig {
                    provider_instance_id: parent.engine.provider_instance_id.clone(),
                    model_selection: goat2_contracts::ModelSelection {
                        model: args
                            .model
                            .clone()
                            .unwrap_or_else(|| parent.engine.model_selection.model.clone()),
                        ..parent.engine.model_selection.clone()
                    },
                    runtime_mode: parent.engine.runtime_mode,
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
        // Register the waiter before the child can finish; the run owns this child as a
        // wait-mode child until it ends, even if the wait times out.
        let rx = wait.then(|| {
            self.record_wait_mode(&caller.run_id, &child.id);
            self.add_waiter(&child.id, caller.run_id.clone())
        });
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
        drop(reservation);
        drop(fenced);
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
        let parked = self.park_caller(caller);
        let waited = tokio::time::timeout(timeout, rx).await;
        if let Some(parked) = parked {
            parked.resume().await;
        }
        if waited.is_err() {
            self.prune_waiters(&child.id);
        }
        match waited {
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
        let _fenced = match self.fence(caller).await {
            Ok(guard) => guard,
            Err(e) => return *e,
        };
        // Keyed per (parent thread, key): a retry after a lost reply or a host restart finds the
        // input it already made.
        let key = args
            .client_request_id
            .as_deref()
            .map(|k| format!("mcp:{}:send:{k}", caller.thread_id));
        if let Some(key) = &key
            && let Some(input_id) = self.input_with_key(&child.id, key).await
        {
            return SurfaceResult::ok(json!({
                "threadId": child.id,
                "inputId": input_id,
                "deduplicated": true,
            }));
        }
        let child_busy = self.runtime_of(&child.id).is_some_and(|rt| rt.busy);
        let _reservation = if child_busy {
            None
        } else {
            match self.reserve_child(&caller.thread_id) {
                Some(r) => Some(r),
                None => {
                    return SurfaceResult::err(
                        ErrorCode::ResourceExhausted,
                        "child_budget",
                        "this thread already runs 4 children",
                        true,
                    );
                }
            }
        };
        let input = NewInput {
            from: InputSource::System,
            text: args.text,
            attachments: Vec::new(),
            mode: args.mode,
            client_request_id: key
                .unwrap_or_else(|| format!("mcp:{}:send:{}", caller.thread_id, new_id("call"))),
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
        self.wait_child(caller, &card.id, args.timeout_ms).await
    }

    async fn thread_stop(&self, caller: &Caller, args: ThreadStopArgs) -> SurfaceResult {
        let card = match self.own_child(caller, &args.thread_id) {
            Ok(c) => c,
            Err(e) => return *e,
        };
        let _fenced = match self.fence(caller).await {
            Ok(guard) => guard,
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
        let _fenced = match self.fence(caller).await {
            Ok(guard) => guard,
            Err(e) => return *e,
        };
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
        let _fenced = match self.fence(caller).await {
            Ok(guard) => guard,
            Err(e) => return *e,
        };
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
        let _fenced = match self.fence(caller).await {
            Ok(guard) => guard,
            Err(e) => return *e,
        };
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
        let summary = clamp_chars(&args.summary, NEEDS_YOU_SUMMARY_MAX_CHARS);
        let handoff = |request_id: &RequestId, state: &str| SurfaceResult::NeedsHuman {
            handoff: Handoff {
                handoff_id: request_id.to_string(),
                kind: format!("{kind:?}").to_lowercase(),
                title: summary.clone(),
                state: state.to_owned(),
                expires_at: None,
                target_path: "request.ask".to_owned(),
            },
            next: None,
        };
        // A key names the request: a retry, also after a restart, returns the same handoff.
        let request_id = match &args.client_request_id {
            Some(key) => RequestId::new(format!(
                "ask_{}",
                crate::util::stable_id(&[caller.thread_id.as_str(), "request.ask", key])
            )),
            None => RequestId::new(new_id("req")),
        };
        if args.client_request_id.is_some() {
            if self
                .inner
                .store
                .fold(&caller.thread_id)
                .is_some_and(|f| f.open_requests.iter().any(|r| r.request_id == request_id))
            {
                return handoff(&request_id, "open");
            }
            let store = self.inner.store.clone();
            let (thread, id) = (caller.thread_id.clone(), request_id.clone());
            let seen = tokio::task::spawn_blocking(move || {
                store.read_page(&thread, u64::MAX, 512).ok().is_some_and(|(lines, _)| {
                    lines.iter().any(|l| matches!(&l.event, LogEvent::RequestOpened(r) if r.request_id == id))
                })
            })
            .await
            .unwrap_or(false);
            if seen {
                return handoff(&request_id, "resolved");
            }
        }
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
        handoff(&request_id, "open")
    }
}
