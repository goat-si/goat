use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::trace::{ExpectedEvent, TraceKind};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Scenario {
    #[schemars(range(min = 1, max = 1))]
    #[serde(deserialize_with = "crate::trace::version_one")]
    pub v: u32,
    pub name: String,
    pub summary: String,
    pub spec: Vec<String>,
    pub v1_refs: Vec<String>,
    pub streams: BTreeMap<String, Stream>,
    pub threads: BTreeMap<String, ThreadDecl>,
    pub steps: Vec<Step>,
    pub expect: Expect,
    pub targets: BTreeMap<String, TargetSupport>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Stream {
    pub engine: Engine,
    pub transcript: String,
    pub provenance: Provenance,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Provenance {
    pub source: String,
    pub commit: String,
    pub source_sha256: String,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Codex,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThreadDecl {
    pub kind: ThreadKind,
    pub stream: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadKind {
    User,
    Bot,
    Worker,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SendMode {
    Start,
    Steer,
    Queue,
    Interrupt,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "until", rename_all = "snake_case", deny_unknown_fields)]
pub enum AwaitCond {
    RunStatus { run: String, status: String },
    Idle,
    Steerable { run: String },
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Step {
    Send {
        id: String,
        thread: String,
        input: String,
        text: String,
        mode: SendMode,
        #[serde(skip_serializing_if = "Option::is_none")]
        run: Option<String>,
    },
    Await {
        id: String,
        thread: String,
        #[serde(flatten)]
        until: AwaitCond,
    },
    Interrupt {
        id: String,
        thread: String,
        run: String,
    },
    QueueEdit {
        id: String,
        thread: String,
        input: String,
        text: String,
    },
    QueueReorder {
        id: String,
        thread: String,
        order: Vec<String>,
    },
    QueueCancel {
        id: String,
        thread: String,
        input: String,
    },
    QueuePromote {
        id: String,
        thread: String,
        input: String,
    },
    Mcp {
        id: String,
        caller: String,
        path: String,
        args: Value,
        call: String,
        wait: bool,
    },
    AwaitCall {
        id: String,
        call: String,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
    },
    RestartHost {
        id: String,
    },
    AdvanceClock {
        id: String,
        ms: u64,
    },
    ReleaseGate {
        id: String,
        label: String,
    },
}
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "do", rename_all = "snake_case")]
enum StepRaw {
    Send {
        id: String,
        thread: String,
        input: String,
        text: String,
        mode: SendMode,
        run: Option<String>,
    },
    Await {
        id: String,
        thread: String,
        #[serde(flatten)]
        until: AwaitCond,
    },
    Interrupt {
        id: String,
        thread: String,
        run: String,
    },
    QueueEdit {
        id: String,
        thread: String,
        input: String,
        text: String,
    },
    QueueReorder {
        id: String,
        thread: String,
        order: Vec<String>,
    },
    QueueCancel {
        id: String,
        thread: String,
        input: String,
    },
    QueuePromote {
        id: String,
        thread: String,
        input: String,
    },
    Mcp {
        id: String,
        caller: String,
        path: String,
        args: Value,
        call: String,
        wait: bool,
    },
    AwaitCall {
        id: String,
        call: String,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
    },
    RestartHost {
        id: String,
    },
    AdvanceClock {
        id: String,
        ms: u64,
    },
    ReleaseGate {
        id: String,
        label: String,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Expect {
    pub complete: bool,
    pub exhaustive: BTreeSet<TraceKind>,
    pub threads: BTreeMap<String, Vec<ExpectedEvent>>,
    pub happens_before: Vec<(String, String)>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TargetSupport {
    pub status: SupportStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expect: Option<Expect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportStatus {
    Supported,
    Unsupported,
    Pending,
}

/// A scenario loaded from disk, with replay streams validated against their provenance.
#[derive(Debug)]
pub struct LoadedScenario {
    pub dir: std::path::PathBuf,
    pub scenario: Scenario,
    pub outbound_counts: BTreeMap<String, usize>,
}
impl LoadedScenario {
    pub fn load(dir: &std::path::Path) -> Result<Self, String> {
        use crate::transcript;
        let data = std::fs::read(dir.join("scenario.json")).map_err(|e| e.to_string())?;
        let scenario: Scenario = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        if scenario.v != 1 {
            return Err("scenario version must be 1".into());
        }
        if scenario.v1_refs.is_empty() {
            return Err("v1Refs must cite at least one v1 source".into());
        }
        let root = dir.canonicalize().map_err(|e| e.to_string())?;
        let mut outbound_counts = BTreeMap::new();
        for (name, stream) in &scenario.streams {
            let path = root
                .join(&stream.transcript)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !path.starts_with(root.join("transcripts")) {
                return Err(format!("transcript escapes transcripts/: {name}"));
            }
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            transcript::verify_hash(&bytes, &stream.provenance.sha256)
                .map_err(|e| e.to_string())?;
            if stream.provenance.transform.is_none()
                && stream.provenance.sha256 != stream.provenance.source_sha256
            {
                return Err(format!("untransformed source hash differs: {name}"));
            }
            if let Some(v1) = std::env::var_os("GOAT_V1_ROOT") {
                let source_root = std::path::PathBuf::from(v1)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                let source = source_root
                    .join(&stream.provenance.source)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if !source.starts_with(&source_root) {
                    return Err("source escapes v1 root".into());
                }
                transcript::verify_hash(
                    &std::fs::read(source).map_err(|e| e.to_string())?,
                    &stream.provenance.source_sha256,
                )
                .map_err(|e| e.to_string())?;
            }
            let records = transcript::parse(&bytes).map_err(|e| e.to_string())?;
            outbound_counts.insert(name.clone(), transcript::outbound_count(&records));
        }
        for (name, thread) in &scenario.threads {
            if !scenario.streams.contains_key(&thread.stream) {
                return Err(format!("unknown stream for {name}"));
            }
            if thread
                .parent
                .as_ref()
                .is_some_and(|p| !scenario.threads.contains_key(p))
            {
                return Err(format!("unknown parent for {name}"));
            }
        }
        let mut ids = BTreeSet::new();
        let mut calls = BTreeSet::new();
        let mut all_calls = BTreeSet::new();
        let mut inputs = BTreeSet::new();
        for step in &scenario.steps {
            let (id, thread) = match step {
                Step::Send {
                    id, thread, input, ..
                } => {
                    if !inputs.insert(input) {
                        return Err(format!("duplicate input {input}"));
                    }
                    (id, Some(thread))
                }
                Step::QueueEdit {
                    id, thread, input, ..
                }
                | Step::QueueCancel { id, thread, input }
                | Step::QueuePromote { id, thread, input } => {
                    if !inputs.contains(input) {
                        return Err(format!("unknown input {input}"));
                    }
                    (id, Some(thread))
                }
                Step::QueueReorder { id, thread, order } => {
                    if order.iter().any(|i| !inputs.contains(i)) {
                        return Err("unknown queue input".into());
                    }
                    (id, Some(thread))
                }
                Step::Await { id, thread, .. } | Step::Interrupt { id, thread, .. } => {
                    (id, Some(thread))
                }
                Step::Mcp {
                    id,
                    caller,
                    call,
                    wait,
                    ..
                } => {
                    if !all_calls.insert(call) {
                        return Err(format!("duplicate call {call}"));
                    }
                    if !*wait {
                        calls.insert(call);
                    }
                    (id, Some(caller))
                }
                Step::AwaitCall { id, call, .. } => {
                    if !calls.contains(call) {
                        return Err(format!("unknown async call {call}"));
                    }
                    (id, None)
                }
                Step::RestartHost { id }
                | Step::AdvanceClock { id, .. }
                | Step::ReleaseGate { id, .. } => (id, None),
            };
            if !ids.insert(id) {
                return Err(format!("duplicate step id {id}"));
            }
            if thread.is_some_and(|t| !scenario.threads.contains_key(t)) {
                return Err(format!("unknown thread for step {id}"));
            }
        }
        for (name, target) in &scenario.targets {
            if target.status != SupportStatus::Supported
                && target.reason.as_deref().is_none_or(|s| s.trim().is_empty())
            {
                return Err(format!("{name} needs reason"));
            }
            if target.expect.is_some()
                && target
                    .decision
                    .as_deref()
                    .is_none_or(|s| s.trim().is_empty())
            {
                return Err(format!("{name} override needs decision"));
            }
        }
        validate_expectations(&scenario, &inputs, &all_calls)?;
        Ok(Self {
            dir: root,
            scenario,
            outbound_counts,
        })
    }
}

fn validate_expectations(
    s: &Scenario,
    inputs: &BTreeSet<&String>,
    calls: &BTreeSet<&String>,
) -> Result<(), String> {
    for expect in
        std::iter::once(&s.expect).chain(s.targets.values().filter_map(|t| t.expect.as_ref()))
    {
        let mut ids = BTreeSet::new();
        for (thread, events) in &expect.threads {
            if !s.threads.contains_key(thread) {
                return Err(format!("unknown expected thread {thread}"));
            }
            for e in events {
                if !ids.insert(e.id.clone()) {
                    return Err(format!("duplicate expected id {}", e.id));
                }
                if crate::compare::thread(&e.event) != thread
                    || !expect.exhaustive.contains(&crate::compare::kind(&e.event))
                {
                    return Err(format!("invalid expected event {}", e.id));
                }
                use crate::trace::TraceEvent::*;
                let input_refs: Vec<&String> = match &e.event {
                    InputAccepted { input, .. }
                    | InputRefused { input, .. }
                    | QueueChanged { input, .. }
                    | SteerApplied { input, .. } => vec![input],
                    RunStarted { inputs, .. } => inputs.iter().collect(),
                    _ => vec![],
                };
                for input in input_refs {
                    if !inputs.contains(input)
                        && !input.split_once('#').is_some_and(|(child, n)| {
                            s.threads.contains_key(child) && n.parse::<u32>().is_ok_and(|n| n > 0)
                        })
                    {
                        return Err(format!("unknown input {input}"));
                    }
                }
                match &e.event {
                    ChildStarted { child, .. }
                    | ChildReported { child, .. }
                    | ParentWoken { child, .. }
                        if !s.threads.contains_key(child) =>
                    {
                        return Err(format!("unknown child {child}"));
                    }
                    ToolResult { call, .. } if !calls.contains(call) => {
                        return Err(format!("unknown call {call}"));
                    }
                    QueueChanged {
                        op: crate::trace::QueueOp::Reordered,
                        position: None,
                        ..
                    } => return Err("reordered event requires position".into()),
                    _ => {}
                }
            }
        }
        let mut edges = std::collections::BTreeMap::<String, Vec<String>>::new();
        for (a, b) in &expect.happens_before {
            if !ids.contains(a) || !ids.contains(b) {
                return Err("unknown happensBefore id".into());
            }
            edges.entry(a.clone()).or_default().push(b.clone());
        }
        fn visit(
            n: &str,
            edges: &std::collections::BTreeMap<String, Vec<String>>,
            active: &mut BTreeSet<String>,
            done: &mut BTreeSet<String>,
        ) -> bool {
            if active.contains(n) {
                return false;
            }
            if done.contains(n) {
                return true;
            }
            active.insert(n.to_owned());
            if let Some(next) = edges.get(n) {
                for x in next {
                    if !visit(x, edges, active, done) {
                        return false;
                    }
                }
            }
            active.remove(n);
            done.insert(n.to_owned());
            true
        }
        let mut active = BTreeSet::new();
        let mut done = BTreeSet::new();
        for id in &ids {
            if !visit(id, &edges, &mut active, &mut done) {
                return Err("cyclic happensBefore".into());
            }
        }
    }
    Ok(())
}

impl<'de> Deserialize<'de> for Step {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let value = Value::deserialize(d)?;
        let object = value
            .as_object()
            .ok_or_else(|| D::Error::custom("step must be an object"))?;
        let tag = object
            .get("do")
            .and_then(Value::as_str)
            .ok_or_else(|| D::Error::custom("missing do"))?;
        let allowed: &[&str] = match tag {
            "send" => &["id", "thread", "input", "text", "mode", "run"],
            "await" => &["id", "thread", "until", "run", "status"],
            "interrupt" => &["id", "thread", "run"],
            "queue_edit" => &["id", "thread", "input", "text"],
            "queue_reorder" => &["id", "thread", "order"],
            "queue_cancel" => &["id", "thread", "input"],
            "queue_promote" => &["id", "thread", "input"],
            "mcp" => &["id", "caller", "path", "args", "call", "wait"],
            "await_call" => &["id", "call", "timeoutMs"],
            "restart_host" => &["id"],
            "advance_clock" => &["id", "ms"],
            "release_gate" => &["id", "label"],
            _ => return Err(D::Error::custom("unknown step")),
        };
        for key in object.keys() {
            if key != "do" && !allowed.contains(&key.as_str()) {
                return Err(D::Error::custom(format!("unknown field {key}")));
            }
        }
        let raw: StepRaw = serde_json::from_value(value).map_err(D::Error::custom)?;
        Ok(match raw {
            StepRaw::Send {
                id,
                thread,
                input,
                text,
                mode,
                run,
            } => Step::Send {
                id,
                thread,
                input,
                text,
                mode,
                run,
            },
            StepRaw::Await { id, thread, until } => Step::Await { id, thread, until },
            StepRaw::Interrupt { id, thread, run } => Step::Interrupt { id, thread, run },
            StepRaw::QueueEdit {
                id,
                thread,
                input,
                text,
            } => Step::QueueEdit {
                id,
                thread,
                input,
                text,
            },
            StepRaw::QueueReorder { id, thread, order } => Step::QueueReorder { id, thread, order },
            StepRaw::QueueCancel { id, thread, input } => Step::QueueCancel { id, thread, input },
            StepRaw::QueuePromote { id, thread, input } => Step::QueuePromote { id, thread, input },
            StepRaw::Mcp {
                id,
                caller,
                path,
                args,
                call,
                wait,
            } => Step::Mcp {
                id,
                caller,
                path,
                args,
                call,
                wait,
            },
            StepRaw::AwaitCall {
                id,
                call,
                timeout_ms,
            } => Step::AwaitCall {
                id,
                call,
                timeout_ms,
            },
            StepRaw::RestartHost { id } => Step::RestartHost { id },
            StepRaw::AdvanceClock { id, ms } => Step::AdvanceClock { id, ms },
            StepRaw::ReleaseGate { id, label } => Step::ReleaseGate { id, label },
        })
    }
}

impl JsonSchema for Step {
    fn schema_name() -> String {
        "Step".into()
    }
    fn json_schema(g: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        use schemars::schema::Schema;
        let mut schema = StepRaw::json_schema(g);
        if let Schema::Object(obj) = &mut schema
            && let Some(sub) = &mut obj.subschemas
            && let Some(variants) = &mut sub.one_of
        {
            for variant in variants {
                if let Schema::Object(variant) = variant {
                    if let Some(sub) = &mut variant.subschemas
                        && let Some(conditions) = &mut sub.one_of
                    {
                        if let Some(base) = &variant.object {
                            for condition in conditions {
                                if let Schema::Object(c) = condition
                                    && let Some(fields) = &mut c.object
                                {
                                    fields.properties.extend(base.properties.clone());
                                    fields.required.extend(base.required.clone());
                                }
                            }
                        }
                    } else if let Some(fields) = &mut variant.object {
                        fields.additional_properties = Some(Box::new(Schema::Bool(false)));
                    }
                }
            }
        }
        schema
    }
}
