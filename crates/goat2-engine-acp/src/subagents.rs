//! Agent-native subagents of one ACP session, projected as v1 projects them.
//!
//! v1 (`packages/provider-acp/src/server/adapter.ts@916b5ccc1b2`): `emitSubagent` (:1790-2070),
//! `projectSubagentNotification` (:1646-1669), root tool routing in `emitTool` (:2519-2629),
//! child-session routing and buffering (:3817-3879), `followNativeChild` (:2335-2404),
//! `finishSubagentFromNotice` (:4675-4725), carryover after the turn (:3741-3775, :4833-4851);
//! statuses from `acpSubagentStatus.ts:3-17`.
//!
//! GOAT 2 has no child thread for an agent-native subagent (`child_thread_id` stays None): its
//! progress goes out as [EngineEvent::SubagentUpdate] (the child's latest reply text, or the title
//! of the child's newest tool), and the finished subagent as `ItemCompleted` with
//! [TurnItemBody::Subagent] in the turn that started it. Subagents still running when that turn
//! ends carry over (Copilot background agents finish later); they are written as interrupted when
//! the turn is interrupted or failed, or when the agent process ends.

use std::collections::HashMap;

use goat2_contracts::{
    ItemId, NativeItemRef, NativeRefStrength, SubagentOrigin, ThreadId, TurnItem, TurnItemBody,
    TurnItemStatus,
};
use goat2_engine_api::EngineEvent;
use serde_json::{Map, Value, json};

use crate::flavor::{AcpFlavor, SubagentSessionEvent, SubagentUpdate};
use crate::items::{
    ToolState, TurnProjector, content_text, now_ms, rfc3339_ms, unfinished_stop_message,
};
use crate::wire::text_field;

/// v1 `adapter.ts:2310`: updates kept for a child session no subagent has claimed yet.
const MAX_PENDING_PER_CHILD: usize = 256;
/// GOAT 2 bound on how many unclaimed child sessions are buffered at once.
const MAX_PENDING_CHILDREN: usize = 64;

/// v1 `acpSubagentStatusIsTerminal`.
pub fn is_terminal(status: TurnItemStatus) -> bool {
    matches!(
        status,
        TurnItemStatus::Completed
            | TurnItemStatus::Failed
            | TurnItemStatus::Interrupted
            | TurnItemStatus::Cancelled
            | TurnItemStatus::Idle
    )
}

/// v1 `acpSubagentStatusBlocksTurnSettlement`.
pub fn blocks_settlement(status: TurnItemStatus) -> bool {
    matches!(status, TurnItemStatus::Running | TurnItemStatus::Pending)
}

/// The JSON of a merged tool call, for handing a held tool to the projector.
pub fn tool_json(tool: &ToolState) -> Value {
    let mut map = Map::new();
    map.insert("toolCallId".into(), json!(tool.tool_call_id));
    for (key, value) in [
        ("title", &tool.title),
        ("kind", &tool.kind),
        ("status", &tool.status),
        ("name", &tool.name),
    ] {
        if let Some(value) = value {
            map.insert(key.into(), json!(value));
        }
    }
    for (key, value) in [
        ("rawInput", &tool.raw_input),
        ("rawOutput", &tool.raw_output),
        ("content", &tool.content),
        ("locations", &tool.locations),
        ("_meta", &tool.meta),
    ] {
        if let Some(value) = value {
            map.insert(key.into(), value.clone());
        }
    }
    Value::Object(map)
}

#[derive(Debug)]
struct Subagent {
    native_task_id: String,
    owner_turn_id: String,
    child_session_id: Option<String>,
    prompt: String,
    title: Option<String>,
    model: Option<String>,
    status: TurnItemStatus,
    result: Option<String>,
    /// Reply text by child message id (v1 `assistantMessages`), and the latest one.
    messages: HashMap<String, String>,
    assistant_text: String,
    child_tools: HashMap<String, ToolState>,
    ordinal: u32,
    started_ms: i64,
    /// The terminal status last written as an item (v1 `terminalStatusProjected`).
    written: Option<TurnItemStatus>,
    /// Its turn was interrupted while the agent kept it running (v1 settled soft interrupt): the
    /// item was written as interrupted, and later reports update its status without writing it
    /// again (v1 carryover with `projectsLateTerminals: false`, adapter.ts:4640-4670, 6544-6556).
    quiet: bool,
}

/// The running turn, as the tracker needs it.
pub struct TurnRef<'a> {
    pub turn_id: &'a str,
    pub projector: &'a mut TurnProjector,
}

/// What the driver does with a root-session tool update.
#[derive(Debug, PartialEq)]
pub enum ToolRoute {
    /// The tracker took it (a subagent, or a tool held until its input arrives).
    Handled,
    /// Project this update as a tool.
    Project(Value),
}

/// Agent-native subagents of one session (v1 `context.subagents` plus carryover).
#[derive(Debug, Default)]
pub struct SubagentTracker {
    thread_id: Option<ThreadId>,
    driver: String,
    provider_instance_id: String,
    session_id: String,
    subagents: Vec<Subagent>,
    /// Root tool calls the projector must not see (subagent launches, provisional tools).
    held_tools: HashMap<String, ToolState>,
    /// Root tool calls that launched a subagent (v1 `suppressNormalTool`).
    launch_tools: std::collections::HashSet<String>,
    /// Displayable updates of child sessions no subagent has claimed yet.
    pending_child: HashMap<String, Vec<Value>>,
    /// Child states reported before the child was bound (v1 `nativeChildren`).
    child_states: HashMap<String, (TurnItemStatus, Option<String>)>,
    /// Delegations seen before their Agent/Task tool: tool id -> child session.
    delegations: HashMap<String, String>,
}

fn nonempty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_owned())
}

impl SubagentTracker {
    pub fn configure(&mut self, thread_id: ThreadId, driver: &str, provider_instance_id: &str) {
        self.thread_id = Some(thread_id);
        self.driver = driver.to_owned();
        self.provider_instance_id = provider_instance_id.to_owned();
    }

    pub fn set_session(&mut self, session_id: &str) {
        self.session_id = session_id.to_owned();
    }

    fn by_native_or_child(&self, native: &str, child: Option<&str>) -> Option<usize> {
        self.subagents
            .iter()
            .position(|s| s.native_task_id == native)
            .or_else(|| child.and_then(|c| self.by_child(c)))
    }

    fn by_child(&self, child: &str) -> Option<usize> {
        self.subagents
            .iter()
            .position(|s| s.child_session_id.as_deref() == Some(child))
    }

    /// A `tool_call` / `tool_call_update` on the root session (v1 `emitTool` :2474-2629).
    pub fn root_tool(
        &mut self,
        flavor: &dyn AcpFlavor,
        native_children: bool,
        update: &Value,
        turn: &mut Option<TurnRef<'_>>,
        out: &mut Vec<EngineEvent>,
    ) -> ToolRoute {
        let Some(id) = text_field(update, "toolCallId") else {
            return ToolRoute::Project(update.clone());
        };
        let mut merged = self
            .held_tools
            .get(&id)
            .cloned()
            .or_else(|| turn.as_ref().and_then(|t| t.projector.tool(&id).cloned()))
            .unwrap_or_else(|| ToolState {
                tool_call_id: id.clone(),
                started_ms: now_ms(),
                ..ToolState::default()
            });
        merged.merge(update);
        let normalized = flavor.normalize_tool_call(merged.clone());
        // v1 :465-468: flavors that report child sessions extract subagents only while following
        // the agent's work state.
        let extraction = !flavor.follows_agent_work_state() || native_children;
        let Some(active) = turn.as_mut() else {
            // v1 :3741-3775: after the turn only terminal reports of known subagents apply.
            if extraction
                && let Some(subagent) = flavor.extract_subagent(&normalized)
                && is_terminal(subagent.status)
            {
                self.held_tools.insert(id, merged);
                self.apply(flavor, subagent, turn, out);
            }
            return ToolRoute::Handled;
        };
        // v1 :2519-2526: a subagent tool without its input yet is not projected.
        if native_children && flavor.is_provisional_subagent_tool(&normalized) {
            self.held_tools.insert(id, merged);
            return ToolRoute::Handled;
        }
        // v1 :2618-2621: a poll of a background task this turn registered resembles subagent
        // hydration; it is a tool.
        let background_report = active
            .projector
            .reports_on_registered_background_task(flavor, &normalized);
        if extraction
            && !background_report
            && let Some(subagent) = flavor.extract_subagent(&normalized)
        {
            active.projector.close_segments(out);
            self.launch_tools.insert(id.clone());
            self.held_tools.insert(id, merged);
            self.apply(flavor, subagent, turn, out);
            return ToolRoute::Handled;
        }
        if self.held_tools.remove(&id).is_some() {
            // A held tool that is not a subagent after all is a tool with what it has so far.
            active.projector.observe_tool_call(&tool_json(&normalized));
        }
        // The projector merges and normalizes the update itself (v1 keeps the normalized state).
        ToolRoute::Project(update.clone())
    }

    /// v1 `emitSubagent` (:1790-2070).
    pub fn apply(
        &mut self,
        flavor: &dyn AcpFlavor,
        update: SubagentUpdate,
        turn: &mut Option<TurnRef<'_>>,
        out: &mut Vec<EngineEvent>,
    ) {
        let terminal = is_terminal(update.status);
        let index = match self
            .by_native_or_child(&update.native_task_id, update.child_session_id.as_deref())
        {
            Some(index) => {
                let existing = &self.subagents[index];
                if is_terminal(existing.status) && !terminal {
                    return;
                }
                if terminal && existing.written == Some(update.status) {
                    return;
                }
                index
            }
            None => {
                // Hydration without a known launch cannot create a subagent (v1 :1816-1822).
                if update.prompt.is_empty() && update.title.is_none() {
                    return;
                }
                let Some(active) = turn.as_mut() else {
                    return;
                };
                let ordinal = active.projector.take_ordinal();
                self.subagents.push(Subagent {
                    native_task_id: update.native_task_id.clone(),
                    owner_turn_id: active.turn_id.to_owned(),
                    child_session_id: None,
                    prompt: update.prompt.clone(),
                    title: update.title.clone(),
                    model: None,
                    status: TurnItemStatus::Pending,
                    result: None,
                    messages: HashMap::new(),
                    assistant_text: String::new(),
                    child_tools: HashMap::new(),
                    ordinal,
                    started_ms: now_ms(),
                    written: None,
                    quiet: false,
                });
                self.subagents.len() - 1
            }
        };
        let subagent = &mut self.subagents[index];
        if let Some(model) = update
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            subagent.model = Some(model.to_owned());
        }
        subagent.status = update.status;
        // v1 :1999-2008: a finished child's reported result stands in for a reply it never streamed.
        if terminal
            && update.status != TurnItemStatus::Failed
            && subagent.assistant_text.is_empty()
            && let Some(result) = &update.result
        {
            subagent.assistant_text = result.clone();
        }
        subagent.result = update
            .result
            .clone()
            .or_else(|| subagent.result.take())
            .or_else(|| nonempty(&subagent.assistant_text));
        let native = subagent.native_task_id.clone();
        let child = update
            .child_session_id
            .clone()
            .or_else(|| self.delegations.remove(&native));
        let mut stashed = None;
        if let Some(child) = &child
            && self.subagents[index].child_session_id.is_none()
        {
            stashed = self.bind(index, child).map(|state| (child.clone(), state));
        }
        self.publish(index, turn, out);
        if let Some((child, (status, result))) = stashed {
            self.child_state(flavor, &child, status, result, turn, out);
        }
    }

    /// Bind a child session; replays what it sent before (v1 :1957-1991). Returns a stashed state.
    fn bind(&mut self, index: usize, child: &str) -> Option<(TurnItemStatus, Option<String>)> {
        self.subagents[index].child_session_id = Some(child.to_owned());
        for update in self.pending_child.remove(child).unwrap_or_default() {
            self.child_message(index, &update);
        }
        self.child_states.remove(child)
    }

    fn publish(&mut self, index: usize, turn: &Option<TurnRef<'_>>, out: &mut Vec<EngineEvent>) {
        let active = turn.as_ref().map(|t| t.turn_id.to_owned());
        let subagent = &self.subagents[index];
        out.push(EngineEvent::SubagentUpdate {
            turn_id: active.filter(|t| *t == subagent.owner_turn_id),
            subagent_id: subagent.native_task_id.clone(),
            status: subagent.status,
            title: subagent.title.clone(),
            progress: nonempty(&subagent.assistant_text),
        });
        if is_terminal(subagent.status)
            && subagent.written != Some(subagent.status)
            && !subagent.quiet
        {
            let item = self.item(subagent);
            out.push(EngineEvent::ItemCompleted {
                turn_id: subagent.owner_turn_id.clone(),
                item: Box::new(item),
                locator: None,
            });
            self.subagents[index].written = Some(self.subagents[index].status);
        }
    }

    fn progress(
        &self,
        index: usize,
        progress: String,
        turn: &Option<TurnRef<'_>>,
        out: &mut Vec<EngineEvent>,
    ) {
        let subagent = &self.subagents[index];
        let active = turn.as_ref().map(|t| t.turn_id.to_owned());
        out.push(EngineEvent::SubagentUpdate {
            turn_id: active.filter(|t| *t == subagent.owner_turn_id),
            subagent_id: subagent.native_task_id.clone(),
            status: subagent.status,
            title: subagent.title.clone(),
            progress: Some(progress),
        });
    }

    fn item(&self, subagent: &Subagent) -> TurnItem {
        let now = now_ms();
        TurnItem {
            id: ItemId::new(format!(
                "{}:subagent:{}",
                subagent.owner_turn_id, subagent.native_task_id
            )),
            thread_id: self.thread_id.clone().unwrap_or_else(|| ThreadId::new("")),
            run_id: None,
            provider_thread_id: Some(self.session_id.clone()),
            provider_turn_id: Some(subagent.owner_turn_id.clone()),
            native_item_ref: Some(NativeItemRef {
                driver: self.driver.clone(),
                native_id: Some(subagent.native_task_id.clone()),
                strength: NativeRefStrength::Strong,
                fingerprint: None,
                ordinal: None,
            }),
            parent_item_id: None,
            ordinal: subagent.ordinal,
            status: subagent.status,
            title: subagent.title.clone(),
            started_at: Some(rfc3339_ms(subagent.started_ms)),
            completed_at: Some(rfc3339_ms(now)),
            updated_at: rfc3339_ms(now),
            body: TurnItemBody::Subagent {
                subagent_id: subagent.native_task_id.clone(),
                origin: SubagentOrigin::ProviderNative,
                driver: self.driver.clone(),
                provider_instance_id: self.provider_instance_id.clone(),
                child_thread_id: None,
                prompt: subagent.prompt.clone(),
                progress: nonempty(&subagent.assistant_text)
                    .filter(|text| subagent.result.as_deref() != Some(text.as_str())),
                result: subagent.result.clone(),
            },
        }
    }

    /// The child's reply text (v1 `projectSubagentNotification` :1646-1669). Returns the new text.
    fn child_message(&mut self, index: usize, update: &Value) -> Option<String> {
        let subagent = &mut self.subagents[index];
        let key = text_field(update, "messageId").unwrap_or_else(|| "result".into());
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                let text = content_text(update.get("content"))?;
                let message = subagent.messages.entry(key).or_default();
                message.push_str(&text);
                subagent.assistant_text = message.clone();
            }
            Some("agent_message") => {
                let blocks = update.get("content")?.as_array()?;
                let text = blocks
                    .iter()
                    .filter_map(|block| content_text(Some(block)))
                    .collect::<Vec<_>>()
                    .join("\n");
                subagent.messages.insert(key, text.clone());
                subagent.assistant_text = text;
            }
            _ => return None,
        }
        Some(subagent.assistant_text.clone())
    }

    /// An update on a session other than the root (v1 :3817-3879, :2335-2404).
    pub fn child_update(
        &mut self,
        flavor: &dyn AcpFlavor,
        native_children: bool,
        session: &str,
        update: &Value,
        turn: &mut Option<TurnRef<'_>>,
        out: &mut Vec<EngineEvent>,
    ) {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let index = self.by_child(session);
        let extraction = !flavor.follows_agent_work_state() || native_children;
        if native_children && kind == "state_update" {
            // v1 :2377-2392.
            let idle = update.get("state").and_then(Value::as_str) == Some("idle");
            let stop = update
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let unfinished = if idle {
                unfinished_stop_message(stop)
            } else {
                None
            };
            let status = if !idle {
                TurnItemStatus::Running
            } else if stop == "error" || unfinished.is_some() {
                TurnItemStatus::Failed
            } else if stop == "cancelled" {
                TurnItemStatus::Cancelled
            } else {
                TurnItemStatus::Completed
            };
            let result = idle
                .then(|| {
                    update
                        .get("error")
                        .and_then(|e| text_field(e, "message"))
                        .or_else(|| unfinished.map(str::to_owned))
                })
                .flatten();
            self.child_state(flavor, session, status, result, turn, out);
            return;
        }
        match kind {
            "tool_call" | "tool_call_update" => {
                let Some(index) = index else {
                    return;
                };
                let Some(id) = text_field(update, "toolCallId") else {
                    return;
                };
                let subagent = &mut self.subagents[index];
                let is_new = !subagent.child_tools.contains_key(&id);
                let tool = subagent
                    .child_tools
                    .entry(id.clone())
                    .or_insert_with(|| ToolState {
                        tool_call_id: id.clone(),
                        started_ms: now_ms(),
                        ..ToolState::default()
                    });
                tool.merge(update);
                let normalized = flavor.normalize_tool_call(tool.clone());
                let native = subagent.native_task_id.clone();
                if extraction && let Some(report) = flavor.extract_subagent(&normalized) {
                    // v1 :3834-3841: the child's own report of the same task.
                    if report.native_task_id == native
                        || report.child_session_id.as_deref() == Some(session)
                    {
                        self.apply(flavor, report, turn, out);
                    }
                    return;
                }
                if turn.is_some() && is_new {
                    let label = normalized
                        .title
                        .clone()
                        .or(normalized.kind.clone())
                        .unwrap_or_else(|| "Tool".into());
                    self.progress(index, label, turn, out);
                }
            }
            "agent_message_chunk" | "agent_message" => {
                let displayable = match kind {
                    "agent_message_chunk" => content_text(update.get("content")).is_some(),
                    _ => update.get("content").is_some_and(|c| !c.is_null()),
                };
                if !displayable {
                    return;
                }
                // v1 `projectNativeChildFrame` (adapter.ts:2298-2333): after its turn, a child
                // still projects into the subagent its completed turn left running (carryover),
                // so its later end carries the reply (final review finding 8). Children of an
                // interrupted turn the agent kept running (quiet) and unclaimed children are not
                // followed outside a turn.
                if turn.is_none()
                    && !index.is_some_and(|i| {
                        let subagent = &self.subagents[i];
                        !is_terminal(subagent.status) && !subagent.quiet
                    })
                {
                    return;
                }
                match index {
                    Some(index) => {
                        if let Some(text) = self.child_message(index, update) {
                            self.progress(index, text, turn, out);
                        }
                    }
                    None => {
                        if !self.pending_child.contains_key(session)
                            && self.pending_child.len() >= MAX_PENDING_CHILDREN
                        {
                            return;
                        }
                        let buffered = self.pending_child.entry(session.to_owned()).or_default();
                        if buffered.len() < MAX_PENDING_PER_CHILD {
                            buffered.push(update.clone());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// A child's state (v1 `setNativeChildState` + `publishNativeChildStatus`).
    fn child_state(
        &mut self,
        flavor: &dyn AcpFlavor,
        child: &str,
        status: TurnItemStatus,
        result: Option<String>,
        turn: &mut Option<TurnRef<'_>>,
        out: &mut Vec<EngineEvent>,
    ) {
        let Some(index) = self.by_child(child) else {
            if self.child_states.len() < MAX_PENDING_CHILDREN
                || self.child_states.contains_key(child)
            {
                self.child_states.insert(child.to_owned(), (status, result));
            }
            return;
        };
        if status == TurnItemStatus::Running {
            return;
        }
        let subagent = &self.subagents[index];
        let update = SubagentUpdate {
            native_task_id: subagent.native_task_id.clone(),
            child_session_id: Some(child.to_owned()),
            prompt: subagent.prompt.clone(),
            title: subagent.title.clone(),
            model: subagent.model.clone(),
            status,
            result,
        };
        self.apply(flavor, update, turn, out);
    }

    /// v1 `extractSubagentSessionEvent` results (`followNativeChild` :2342-2369).
    pub fn session_event(
        &mut self,
        flavor: &dyn AcpFlavor,
        event: SubagentSessionEvent,
        turn: &mut Option<TurnRef<'_>>,
        out: &mut Vec<EngineEvent>,
    ) {
        match event {
            SubagentSessionEvent::State {
                child_session_id,
                status,
                result,
                ..
            } => self.child_state(flavor, &child_session_id, status, result, turn, out),
            SubagentSessionEvent::Delegation {
                child_session_id,
                delegation_id,
                ..
            } => {
                let owner = self
                    .subagents
                    .iter()
                    .position(|s| s.native_task_id == delegation_id);
                match owner {
                    Some(index) if self.subagents[index].child_session_id.is_none() => {
                        if let Some((status, result)) = self.bind(index, &child_session_id) {
                            self.child_state(flavor, &child_session_id, status, result, turn, out);
                        }
                    }
                    Some(_) => {}
                    None => {
                        if self.delegations.len() < MAX_PENDING_CHILDREN {
                            self.delegations.insert(delegation_id, child_session_id);
                        }
                    }
                }
            }
        }
    }

    /// An extension said the child session ended (v1 `finishSubagentFromNotice` :4675-4725).
    pub fn finish(
        &mut self,
        flavor: &dyn AcpFlavor,
        child: &str,
        status: TurnItemStatus,
        result: Option<String>,
        turn: &mut Option<TurnRef<'_>>,
        out: &mut Vec<EngineEvent>,
    ) {
        let Some(index) = self.by_child(child).or_else(|| {
            self.subagents
                .iter()
                .position(|s| s.native_task_id == child)
        }) else {
            return;
        };
        let subagent = &self.subagents[index];
        if !blocks_settlement(subagent.status) {
            return;
        }
        let update = SubagentUpdate {
            native_task_id: subagent.native_task_id.clone(),
            child_session_id: Some(child.to_owned()),
            prompt: subagent.prompt.clone(),
            title: subagent.title.clone(),
            model: subagent.model.clone(),
            status,
            result,
        };
        self.apply(flavor, update, turn, out);
    }

    /// v1 `extractSubagentEndNotice` (adapter.ts:3775-3797, 4088-4111): a subagent end the agent
    /// announced in injected user text (xAI `Background subagent <id> ... completed`).
    pub fn injected_user_text(
        &mut self,
        flavor: &dyn AcpFlavor,
        text: &str,
        turn: &mut Option<TurnRef<'_>>,
        out: &mut Vec<EngineEvent>,
    ) {
        if let Some(notice) = flavor.subagent_end_notice(text) {
            self.finish(
                flavor,
                &notice.child_session_id,
                notice.status,
                None,
                turn,
                out,
            );
        }
    }

    /// v1 `hasAcpDeferredBackgroundWork` (deferredBackground.ts:13-43): a subagent the turn
    /// started still runs.
    pub fn blocks_turn(&self, turn_id: &str) -> bool {
        self.subagents
            .iter()
            .any(|s| s.owner_turn_id == turn_id && blocks_settlement(s.status))
    }

    /// Before the turn's projector finishes: held tools that never became subagents are tools.
    pub fn release_held_tools(&mut self, projector: &mut TurnProjector) {
        let held = std::mem::take(&mut self.held_tools);
        for (id, tool) in held {
            if !self.launch_tools.contains(&id) && projector.tool(&id).is_none() {
                projector.observe_tool_call(&tool_json(&tool));
            }
        }
    }

    /// The turn ended. An interrupted or failed turn interrupts its running subagents
    /// (v1 `terminalizeCarryoverSubagents` :4833-4851); after a completed turn they carry over.
    /// `kept_running`: the turn was interrupted after its prompt answered and the agent was left
    /// running (v1 `preserveRuntimeOnSettledInterrupt`, :7874-7900, 6544-6556): its subagents are
    /// written as interrupted with the turn but keep running, and their later ends only update
    /// their status.
    pub fn turn_settled(
        &mut self,
        turn_id: &str,
        completed: bool,
        kept_running: bool,
        out: &mut Vec<EngineEvent>,
    ) {
        if completed {
            return;
        }
        if kept_running {
            for index in 0..self.subagents.len() {
                let subagent = &self.subagents[index];
                if subagent.owner_turn_id != turn_id || is_terminal(subagent.status) {
                    continue;
                }
                let mut item = self.item(subagent);
                item.status = TurnItemStatus::Interrupted;
                out.push(EngineEvent::ItemCompleted {
                    turn_id: turn_id.to_owned(),
                    item: Box::new(item),
                    locator: None,
                });
                self.subagents[index].written = Some(TurnItemStatus::Interrupted);
                self.subagents[index].quiet = true;
            }
            return;
        }
        self.interrupt_where(|s| s.owner_turn_id == turn_id, out);
    }

    /// The agent process ended: every subagent still running is interrupted.
    pub fn exited(&mut self, out: &mut Vec<EngineEvent>) {
        self.interrupt_where(|_| true, out);
        self.pending_child.clear();
        self.child_states.clear();
        self.delegations.clear();
    }

    fn interrupt_where(&mut self, matches: impl Fn(&Subagent) -> bool, out: &mut Vec<EngineEvent>) {
        for index in 0..self.subagents.len() {
            if matches(&self.subagents[index]) && !is_terminal(self.subagents[index].status) {
                self.subagents[index].status = TurnItemStatus::Interrupted;
                self.publish(index, &None, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flavor::LaunchCommand;
    use crate::registry::RegistryAgentFlavor;

    fn tracker() -> SubagentTracker {
        let mut tracker = SubagentTracker::default();
        tracker.configure(ThreadId::new("thread-1"), "acpRegistry", "registry");
        tracker.set_session("root");
        tracker
    }

    fn flavor(agent: &str) -> RegistryAgentFlavor {
        RegistryAgentFlavor::new(
            agent,
            LaunchCommand::new("agent", Vec::<String>::new()),
            false,
        )
    }

    fn projector() -> TurnProjector {
        TurnProjector::new(
            ThreadId::new("thread-1"),
            "acpRegistry",
            "root",
            "turn-1",
            0,
        )
    }

    fn subagent_items(out: &[EngineEvent]) -> Vec<(String, TurnItem)> {
        out.iter()
            .filter_map(|e| match e {
                EngineEvent::ItemCompleted { turn_id, item, .. }
                    if matches!(item.body, TurnItemBody::Subagent { .. }) =>
                {
                    Some((turn_id.clone(), (**item).clone()))
                }
                _ => None,
            })
            .collect()
    }

    fn result_of(item: &TurnItem) -> Option<String> {
        match &item.body {
            TurnItemBody::Subagent { result, .. } => result.clone(),
            _ => None,
        }
    }

    /// v1 claudeAcp.ts + adapter.ts:2335-2404, 2519-2526 (negotiated ACP v2).
    #[test]
    fn claude_v2_child_sessions_drive_the_subagent() {
        let flavor = flavor("claude-acp");
        let mut tracker = tracker();
        let mut projector = projector();
        let mut out = Vec::new();
        let mut turn = Some(TurnRef {
            turn_id: "turn-1",
            projector: &mut projector,
        });
        let pending = json!({"sessionUpdate": "tool_call", "toolCallId": "toolu_1", "name": "Agent", "status": "pending"});
        assert_eq!(
            tracker.root_tool(&flavor, true, &pending, &mut turn, &mut out),
            ToolRoute::Handled
        );
        assert!(out.is_empty(), "a provisional Agent call is held");
        let input = json!({"sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "in_progress", "rawInput": {"prompt": "find bugs", "description": "Bug hunt"}});
        assert_eq!(
            tracker.root_tool(&flavor, true, &input, &mut turn, &mut out),
            ToolRoute::Handled
        );
        assert!(
            matches!(&out[..], [EngineEvent::SubagentUpdate { subagent_id, status: TurnItemStatus::Running, turn_id: Some(t), .. }] if subagent_id == "toolu_1" && t == "turn-1")
        );
        // The child replies before its delegation names it: buffered, then replayed on binding.
        let reply = json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "found 2 bugs"}});
        tracker.child_update(&flavor, true, "child-s", &reply, &mut turn, &mut out);
        let delegation = json!({"sessionId": "child-s", "update": {"sessionUpdate": "session_message", "messageId": "toolu_1", "senderSessionId": "root", "content": [{"type": "text", "text": "find bugs"}]}});
        let event = flavor.extract_subagent_session_event(&delegation).unwrap();
        tracker.session_event(&flavor, event, &mut turn, &mut out);
        let idle = json!({"sessionId": "root", "update": {"sessionUpdate": "subagent_update", "sessionId": "child-s", "state": {"state": "idle", "stopReason": "end_turn"}}});
        let event = flavor.extract_subagent_session_event(&idle).unwrap();
        tracker.session_event(&flavor, event, &mut turn, &mut out);
        let written = subagent_items(&out);
        assert_eq!(written.len(), 1);
        assert_eq!(written[0].0, "turn-1");
        assert_eq!(written[0].1.status, TurnItemStatus::Completed);
        assert_eq!(result_of(&written[0].1).as_deref(), Some("found 2 bugs"));
        // The tool's own completion repeats the same status: nothing new is written.
        let done = json!({"sessionUpdate": "tool_call_update", "toolCallId": "toolu_1", "status": "completed"});
        assert_eq!(
            tracker.root_tool(&flavor, true, &done, &mut turn, &mut out),
            ToolRoute::Handled
        );
        assert_eq!(subagent_items(&out).len(), 1);

        // On ACP v1 the same call is an ordinary tool (v1 adapter.ts:465-468).
        let mut v1 = SubagentTracker::default();
        let mut v1_projector = TurnProjector::new(
            ThreadId::new("thread-1"),
            "acpRegistry",
            "root",
            "turn-1",
            0,
        );
        let mut turn = Some(TurnRef {
            turn_id: "turn-1",
            projector: &mut v1_projector,
        });
        assert!(matches!(
            v1.root_tool(&flavor, false, &input, &mut turn, &mut out),
            ToolRoute::Project(_)
        ));
    }

    /// v1 adapter.ts:3741-3775, 4675-4725, 4833-4851.
    #[test]
    fn background_subagents_outlive_a_completed_turn_only() {
        let flavor = flavor("github-copilot-cli");
        let launch = |id: &str| {
            json!({"sessionUpdate": "tool_call", "toolCallId": id, "status": "completed",
            "rawInput": {"agent_type": "explore", "prompt": "map", "mode": "background"}})
        };
        let mut tracker = tracker();
        let mut out = Vec::new();
        let mut projector = projector();
        {
            let mut turn = Some(TurnRef {
                turn_id: "turn-1",
                projector: &mut projector,
            });
            tracker.root_tool(&flavor, false, &launch("task-1"), &mut turn, &mut out);
        }
        out.clear();
        tracker.release_held_tools(&mut projector);
        assert!(
            projector.tool("task-1").is_none(),
            "the launch never becomes a tool"
        );
        tracker.turn_settled("turn-1", true, false, &mut out);
        assert!(
            out.is_empty(),
            "a completed turn leaves background agents running"
        );
        tracker.finish(
            &flavor,
            "copilot-task:task-1",
            TurnItemStatus::Completed,
            Some("mapped".into()),
            &mut None,
            &mut out,
        );
        assert!(matches!(
            &out[0],
            EngineEvent::SubagentUpdate {
                turn_id: None,
                status: TurnItemStatus::Completed,
                ..
            }
        ));
        let written = subagent_items(&out);
        assert_eq!(
            written[0].0, "turn-1",
            "written into the turn that started it"
        );
        assert_eq!(result_of(&written[0].1).as_deref(), Some("mapped"));
        // A second finish of a finished subagent changes nothing.
        out.clear();
        tracker.finish(
            &flavor,
            "copilot-task:task-1",
            TurnItemStatus::Failed,
            None,
            &mut None,
            &mut out,
        );
        assert!(out.is_empty());

        // An interrupted turn interrupts its running subagents; the process end interrupts the rest.
        let mut projector = TurnProjector::new(
            ThreadId::new("thread-1"),
            "acpRegistry",
            "root",
            "turn-2",
            5,
        );
        {
            let mut turn = Some(TurnRef {
                turn_id: "turn-2",
                projector: &mut projector,
            });
            tracker.root_tool(&flavor, false, &launch("task-2"), &mut turn, &mut out);
        }
        let mut projector = TurnProjector::new(
            ThreadId::new("thread-1"),
            "acpRegistry",
            "root",
            "turn-3",
            9,
        );
        {
            let mut turn = Some(TurnRef {
                turn_id: "turn-3",
                projector: &mut projector,
            });
            tracker.root_tool(&flavor, false, &launch("task-3"), &mut turn, &mut out);
        }
        out.clear();
        tracker.turn_settled("turn-2", false, false, &mut out);
        let written = subagent_items(&out);
        assert_eq!(written.len(), 1);
        assert_eq!(
            (written[0].0.as_str(), written[0].1.status),
            ("turn-2", TurnItemStatus::Interrupted)
        );
        out.clear();
        tracker.exited(&mut out);
        let written = subagent_items(&out);
        assert_eq!(written.len(), 1);
        assert_eq!(
            (written[0].0.as_str(), written[0].1.status),
            ("turn-3", TurnItemStatus::Interrupted)
        );
    }

    /// v1 adapter.ts:6544-6556, 4640-4670, 7874-7900 (Grok `preserveRuntimeOnSettledInterrupt`): a
    /// turn interrupted while the agent keeps running writes its subagents as interrupted, and their
    /// later end only updates their status.
    #[test]
    fn subagents_of_a_kept_running_turn_end_quietly() {
        let flavor = crate::agents::grok::Grok::default();
        let mut tracker = tracker();
        let mut projector = projector();
        let mut out = Vec::new();
        let child = "11111111-2222-3333-4444-555555555555";
        {
            let mut turn = Some(TurnRef {
                turn_id: "turn-1",
                projector: &mut projector,
            });
            let spawn = json!({"sessionUpdate": "tool_call", "toolCallId": "spawn-1", "title": "Task",
                "status": "completed", "rawInput": {"prompt": "Count the files", "description": "File counter"},
                "rawOutput": {"text": format!("Subagent started in background.\nsubagent_id: {child}")}});
            assert_eq!(
                tracker.root_tool(&flavor, false, &spawn, &mut turn, &mut out),
                ToolRoute::Handled
            );
        }
        assert!(tracker.blocks_turn("turn-1"));
        out.clear();
        tracker.turn_settled("turn-1", false, true, &mut out);
        let written = subagent_items(&out);
        assert_eq!(written.len(), 1);
        assert_eq!(written[0].1.status, TurnItemStatus::Interrupted);
        out.clear();
        tracker.injected_user_text(
            &flavor,
            &format!("Background subagent {child} (File counter) completed successfully"),
            &mut None,
            &mut out,
        );
        assert!(matches!(
            &out[..],
            [EngineEvent::SubagentUpdate {
                turn_id: None,
                status: TurnItemStatus::Completed,
                ..
            }]
        ));
        out.clear();
        tracker.exited(&mut out);
        assert!(out.is_empty(), "an ended subagent is not interrupted again");
    }

    /// v1 adapter.ts:1816-1822: hydration without a known launch does not create a subagent.
    #[test]
    fn hydration_only_reports_are_ignored() {
        let flavor = flavor("devin");
        let mut tracker = tracker();
        let mut projector = projector();
        let mut out = Vec::new();
        let mut turn = Some(TurnRef {
            turn_id: "turn-1",
            projector: &mut projector,
        });
        let completed = json!({"sessionUpdate": "tool_call", "toolCallId": "x", "status": "completed",
            "_meta": {"cognition.ai/subagent_completed": {"agentId": "ghost", "summary": "?"}}});
        assert_eq!(
            tracker.root_tool(&flavor, false, &completed, &mut turn, &mut out),
            ToolRoute::Handled
        );
        assert!(out.is_empty());
    }

    /// Final review finding 8 (v1 adapter.ts:2298-2333): a carried-over subagent's reply that
    /// arrives after its turn completed is kept, so its later end carries the reply.
    #[test]
    fn carryover_child_reply_after_the_turn_is_kept() {
        let flavor = flavor("claude-acp");
        let mut tracker = tracker();
        let mut projector = projector();
        let mut out = Vec::new();
        {
            let mut turn = Some(TurnRef {
                turn_id: "turn-1",
                projector: &mut projector,
            });
            let launch = json!({"sessionUpdate": "tool_call", "toolCallId": "toolu_1", "name": "Agent", "status": "in_progress", "rawInput": {"prompt": "find bugs", "description": "Bug hunt"}});
            tracker.root_tool(&flavor, true, &launch, &mut turn, &mut out);
            let delegation = json!({"sessionId": "child-s", "update": {"sessionUpdate": "session_message", "messageId": "toolu_1", "senderSessionId": "root", "content": [{"type": "text", "text": "find bugs"}]}});
            let event = flavor.extract_subagent_session_event(&delegation).unwrap();
            tracker.session_event(&flavor, event, &mut turn, &mut out);
        }
        tracker.turn_settled("turn-1", true, false, &mut out);
        out.clear();
        let reply = json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "found 2 bugs"}});
        tracker.child_update(&flavor, true, "child-s", &reply, &mut None, &mut out);
        let idle = json!({"sessionId": "root", "update": {"sessionUpdate": "subagent_update", "sessionId": "child-s", "state": {"state": "idle", "stopReason": "end_turn"}}});
        let event = flavor.extract_subagent_session_event(&idle).unwrap();
        tracker.session_event(&flavor, event, &mut None, &mut out);
        let written = subagent_items(&out);
        assert_eq!(written.len(), 1);
        assert_eq!(written[0].0, "turn-1");
        assert_eq!(written[0].1.status, TurnItemStatus::Completed);
        assert_eq!(result_of(&written[0].1).as_deref(), Some("found 2 bugs"));
    }
}
