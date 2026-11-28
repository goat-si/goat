//! Mapping of log evidence; aliases are resolved by the target harness.
use crate::{
    scenario::SendMode,
    trace::{Origin, QueueOp, RunEnd, TraceEvent},
};
use goat2_contracts::log::{
    DeliveredAs, DeliveryOutcome, InputMode, InputSource, LogEvent, ParsedLine, RunOutcome,
};

#[derive(Debug, thiserror::Error)]
pub enum MappingError {
    #[error("ambiguous input.changed for {0}")]
    Ambiguous(String),
    #[error("invalid log: {0}")]
    Invalid(#[from] serde_json::Error),
    #[error("unmapped id: {0}")]
    Unmapped(String),
}

fn map_log_event(thread: &str, event: &LogEvent) -> Result<Vec<TraceEvent>, MappingError> {
    let thread = thread.to_owned();
    let mut out = Vec::new();
    match event {
        LogEvent::InputAccepted(e) => out.push(TraceEvent::InputAccepted {
            thread,
            input: e.input_id.to_string(),
            from: match &e.from {
                InputSource::User => Origin::User,
                InputSource::Child { .. } => Origin::Child,
                InputSource::System => Origin::System,
            },
            mode: match e.mode {
                InputMode::Steer => SendMode::Steer,
                InputMode::Followup | InputMode::Collect => SendMode::Queue,
                InputMode::Interrupt => SendMode::Interrupt,
            },
            text: Some(e.text.clone()),
        }),
        LogEvent::InputChanged(e) => {
            if (e.text.is_none()
                && e.position.is_none()
                && e.mode.is_none()
                && e.cancelled.is_none())
                || e.mode.is_some_and(|m| m != InputMode::Steer)
                || e.cancelled == Some(false)
            {
                return Err(MappingError::Ambiguous(e.input_id.to_string()));
            }
            let mut add = |op, text, position| {
                out.push(TraceEvent::QueueChanged {
                    thread: thread.clone(),
                    input: e.input_id.to_string(),
                    op,
                    text,
                    position,
                })
            };
            if let Some(text) = &e.text {
                add(QueueOp::Edited, Some(text.clone()), None);
            }
            if let Some(position) = e.position {
                add(QueueOp::Reordered, None, Some(position));
            }
            if e.mode == Some(InputMode::Steer) {
                add(QueueOp::Promoted, None, None);
            }
            if e.cancelled == Some(true) {
                add(QueueOp::Cancelled, None, None);
            }
        }
        LogEvent::InputDelivered(e) => {
            if e.delivered_as == DeliveredAs::Steer && e.outcome == DeliveryOutcome::Accepted {
                out.push(TraceEvent::SteerApplied {
                    thread,
                    run: e.run_id.to_string(),
                    input: e.input_id.to_string(),
                });
            } else if e.outcome == DeliveryOutcome::Refused {
                // Fails closed: the engine refused the delivery and nothing was sent.
                out.push(TraceEvent::InputRefused {
                    thread,
                    input: e.input_id.to_string(),
                    code: "delivery_refused".into(),
                });
            }
        }
        LogEvent::RunStarted(e) => out.push(TraceEvent::RunStarted {
            thread,
            run: e.run_id.to_string(),
            inputs: e.input_ids.iter().map(ToString::to_string).collect(),
        }),
        LogEvent::RunFinished(e) => out.push(TraceEvent::RunFinished {
            thread,
            run: e.run_id.to_string(),
            status: match e.outcome {
                RunOutcome::Completed => RunEnd::Done,
                RunOutcome::Failed => RunEnd::Failed,
                RunOutcome::Interrupted => RunEnd::Interrupted,
                RunOutcome::Unknown => RunEnd::Unknown,
            },
            cause: e.reason.clone(),
        }),
        LogEvent::ChildStarted(e) => out.push(TraceEvent::ChildStarted {
            thread,
            child: e.child_thread_id.to_string(),
        }),
        LogEvent::ChildReported(e) => out.push(TraceEvent::ChildReported {
            thread,
            child: e.child_thread_id.to_string(),
            status: serde_json::to_value(e.status)?
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        }),
        LogEvent::ThreadCreated(_)
        | LogEvent::ThreadChanged(_)
        | LogEvent::RunAccepted(_)
        | LogEvent::ItemCompleted(_)
        | LogEvent::RequestOpened(_)
        | LogEvent::RequestResolved(_)
        | LogEvent::UserNotified(_)
        | LogEvent::Checkpoint(_) => {}
    }
    Ok(out)
}

/// Correlation state for a single parent thread. Register command request IDs and child IDs
/// before consuming the log. Run and wake aliases are assigned in observed order.
#[derive(Default)]
pub struct AliasMap {
    thread: Option<String>,
    pub requests: std::collections::BTreeMap<String, String>,
    request_modes: std::collections::BTreeMap<String, SendMode>,
    pub children: std::collections::BTreeMap<String, String>,
    inputs: std::collections::BTreeMap<String, String>,
    runs: std::collections::BTreeMap<String, String>,
    wakes: std::collections::BTreeMap<String, (String, String)>,
    bound_wakes: std::collections::BTreeMap<String, (String, String, String)>,
    child_inputs: std::collections::BTreeMap<String, (String, String)>,
    run_count: usize,
    wake_count: usize,
    child_counts: std::collections::BTreeMap<String, usize>,
}
impl AliasMap {
    pub fn register_request(&mut self, request_id: impl Into<String>, alias: impl Into<String>) {
        self.requests.insert(request_id.into(), alias.into());
    }
    /// Specify the scenario send mode when a log mode alone cannot distinguish start and queue.
    pub fn register_request_mode(
        &mut self,
        request_id: impl Into<String>,
        alias: impl Into<String>,
        mode: SendMode,
    ) {
        let id = request_id.into();
        self.requests.insert(id.clone(), alias.into());
        self.request_modes.insert(id, mode);
    }
    pub fn register_child(&mut self, id: impl Into<String>, alias: impl Into<String>) {
        self.children.insert(id.into(), alias.into());
    }
    /// Bind a child input to a previously observed child.reported wake using harness evidence.
    pub fn bind_child_input(
        &mut self,
        input_id: impl Into<String>,
        wake: &str,
    ) -> Result<(), MappingError> {
        let (child, input_alias) = self
            .wakes
            .remove(wake)
            .ok_or_else(|| MappingError::Unmapped(wake.into()))?;
        let input_id = input_id.into();
        if self.bound_wakes.contains_key(&input_id) || self.inputs.contains_key(&input_id) {
            self.wakes.insert(wake.into(), (child, input_alias));
            return Err(MappingError::Ambiguous(input_id));
        }
        self.bound_wakes
            .insert(input_id, (child, wake.into(), input_alias));
        Ok(())
    }
    fn input(&self, id: &str) -> Result<String, MappingError> {
        self.inputs
            .get(id)
            .cloned()
            .ok_or_else(|| MappingError::Unmapped(id.into()))
    }
    fn run(&self, id: &str) -> Result<String, MappingError> {
        self.runs
            .get(id)
            .cloned()
            .ok_or_else(|| MappingError::Unmapped(id.into()))
    }
    fn child(&self, id: &str) -> Result<String, MappingError> {
        self.children
            .get(id)
            .cloned()
            .ok_or_else(|| MappingError::Unmapped(id.into()))
    }
    pub fn map(&mut self, thread: &str, event: &LogEvent) -> Result<Vec<TraceEvent>, MappingError> {
        use crate::trace::WakeState;
        match &self.thread {
            Some(owner) if owner != thread => {
                return Err(MappingError::Unmapped(format!(
                    "thread {thread} (aliases belong to {owner})"
                )));
            }
            None => self.thread = Some(thread.to_owned()),
            _ => {}
        }
        let mut wake = Vec::new();
        match event {
            LogEvent::InputAccepted(e) => {
                let alias = match &e.from {
                    InputSource::Child { thread_id } => {
                        let child = self.child(thread_id.as_str())?;
                        let (bound_child, wake_alias, input_alias) = self
                            .bound_wakes
                            .remove(e.input_id.as_str())
                            .ok_or_else(|| {
                                MappingError::Unmapped(format!("wake input {}", e.input_id))
                            })?;
                        if bound_child != child {
                            return Err(MappingError::Unmapped(e.input_id.to_string()));
                        }
                        self.child_inputs
                            .insert(e.input_id.to_string(), (child.clone(), wake_alias));
                        input_alias
                    }
                    _ => self
                        .requests
                        .get(&e.client_request_id)
                        .cloned()
                        .ok_or_else(|| MappingError::Unmapped(e.client_request_id.clone()))?,
                };
                self.inputs.insert(e.input_id.to_string(), alias);
            }
            LogEvent::ChildReported(e) => {
                let child = self.child(e.child_thread_id.as_str())?;
                let count = self.child_counts.entry(child.clone()).or_default();
                *count += 1;
                let input_alias = format!("{child}#{count}");
                self.wake_count += 1;
                self.wakes
                    .insert(format!("w{}", self.wake_count), (child, input_alias));
            }
            LogEvent::RunStarted(e) => {
                if !self.runs.contains_key(e.run_id.as_str()) {
                    self.run_count += 1;
                    self.runs
                        .insert(e.run_id.to_string(), format!("r{}", self.run_count));
                }
                for input in &e.input_ids {
                    if let Some((child, w)) = self.child_inputs.get(input.as_str()) {
                        wake.push(TraceEvent::ParentWoken {
                            thread: thread.into(),
                            child: child.clone(),
                            wake: w.clone(),
                            state: WakeState::Started,
                            run: Some(self.run(e.run_id.as_str())?),
                        });
                    }
                }
            }
            LogEvent::InputDelivered(e)
                if e.delivered_as == DeliveredAs::Steer
                    && e.outcome == DeliveryOutcome::Accepted =>
            {
                if let Some((child, w)) = self.child_inputs.get(e.input_id.as_str()) {
                    wake.push(TraceEvent::ParentWoken {
                        thread: thread.into(),
                        child: child.clone(),
                        wake: w.clone(),
                        state: WakeState::Steered,
                        run: Some(self.run(e.run_id.as_str())?),
                    });
                }
            }
            _ => {}
        }
        let mut result = map_log_event(thread, event)?;
        if let (LogEvent::InputAccepted(source), Some(TraceEvent::InputAccepted { mode, .. })) =
            (event, result.first_mut())
        {
            // Only followup/collect need the requested start/queue distinction; an observed steer or
            // interrupt is kept as observed so a contradiction with the request shows up in compare.
            if matches!(source.mode, InputMode::Followup | InputMode::Collect) {
                if let Some(requested) = self.request_modes.get(&source.client_request_id) {
                    *mode = requested.clone();
                } else if !matches!(source.from, InputSource::Child { .. }) {
                    return Err(MappingError::Ambiguous(source.input_id.to_string()));
                }
            }
        }
        for e in &mut result {
            use TraceEvent::*;
            match e {
                InputAccepted { input, .. }
                | InputRefused { input, .. }
                | QueueChanged { input, .. } => *input = self.input(input)?,
                RunStarted { run, inputs, .. } => {
                    *run = self.run(run)?;
                    for input in inputs {
                        *input = self.input(input)?;
                    }
                }
                SteerApplied { run, input, .. } => {
                    *run = self.run(run)?;
                    *input = self.input(input)?;
                }
                RunFinished { run, .. } => *run = self.run(run)?,
                ChildStarted { child, .. } | ChildReported { child, .. } => {
                    *child = self.child(child)?
                }
                ParentWoken { .. } | ToolResult { .. } | HostRestarted { .. } => {
                    unreachable!("not produced by log mapper")
                }
            }
        }
        result.extend(wake);
        Ok(result)
    }
    pub fn map_line(
        &mut self,
        thread: &str,
        line: &str,
        incomplete: &mut bool,
    ) -> Result<Vec<TraceEvent>, MappingError> {
        match goat2_contracts::parse_log_line(line)? {
            ParsedLine::Known(line) => self.map(thread, &line.event),
            ParsedLine::Unknown { .. } => {
                *incomplete = true;
                Ok(Vec::new())
            }
        }
    }
}
