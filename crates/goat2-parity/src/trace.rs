use crate::scenario::SendMode;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

macro_rules! string_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
    };
}
string_enum!(Origin {
    User,
    Child,
    System,
    Agent
});
string_enum!(QueueOp {
    Enqueued,
    Edited,
    Promoted,
    Cancelled,
    Reordered,
    Held,
    Released
});
string_enum!(RunEnd {
    Done,
    Failed,
    Interrupted,
    Cancelled,
    Unknown
});
string_enum!(WakeState {
    Queued,
    Started,
    Steered,
    Cancelled
});
string_enum!(ToolStatus {
    Ok,
    Error,
    NeedsHuman
});
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
pub enum TraceKind {
    #[serde(rename = "input.accepted")]
    InputAccepted,
    #[serde(rename = "input.refused")]
    InputRefused,
    #[serde(rename = "queue.changed")]
    QueueChanged,
    #[serde(rename = "run.started")]
    RunStarted,
    #[serde(rename = "steer.applied")]
    SteerApplied,
    #[serde(rename = "run.finished")]
    RunFinished,
    #[serde(rename = "child.started")]
    ChildStarted,
    #[serde(rename = "child.reported")]
    ChildReported,
    #[serde(rename = "parent.woken")]
    ParentWoken,
    #[serde(rename = "tool.result")]
    ToolResult,
    #[serde(rename = "host.restarted")]
    HostRestarted,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum TraceEvent {
    #[serde(rename = "input.accepted")]
    InputAccepted {
        thread: String,
        input: String,
        from: Origin,
        mode: SendMode,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    #[serde(rename = "input.refused")]
    InputRefused {
        thread: String,
        input: String,
        code: String,
    },
    #[serde(rename = "queue.changed")]
    QueueChanged {
        thread: String,
        input: String,
        op: QueueOp,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        position: Option<u32>,
    },
    #[serde(rename = "run.started")]
    RunStarted {
        thread: String,
        run: String,
        inputs: Vec<String>,
    },
    #[serde(rename = "steer.applied")]
    SteerApplied {
        thread: String,
        run: String,
        input: String,
    },
    #[serde(rename = "run.finished")]
    RunFinished {
        thread: String,
        run: String,
        status: RunEnd,
        #[serde(skip_serializing_if = "Option::is_none")]
        cause: Option<String>,
    },
    #[serde(rename = "child.started")]
    ChildStarted { thread: String, child: String },
    #[serde(rename = "child.reported")]
    ChildReported {
        thread: String,
        child: String,
        status: String,
    },
    #[serde(rename = "parent.woken")]
    ParentWoken {
        thread: String,
        child: String,
        wake: String,
        state: WakeState,
        #[serde(skip_serializing_if = "Option::is_none")]
        run: Option<String>,
    },
    #[serde(rename = "tool.result")]
    ToolResult {
        thread: String,
        call: String,
        path: String,
        status: ToolStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    #[serde(rename = "host.restarted")]
    HostRestarted { thread: String },
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExpectedEvent {
    pub id: String,
    #[serde(flatten)]
    pub event: TraceEvent,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ObservedEvent {
    pub seq: u64,
    #[serde(flatten)]
    pub event: TraceEvent,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "outcome", rename_all = "snake_case", deny_unknown_fields)]
pub enum Outcome {
    Ok,
    Unsupported { reason: String },
    Error { reason: String },
    Incomplete { reason: String },
    PendingExpectation { reason: String },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StreamReport {
    pub consumed_all: bool,
    pub outbound_checked: u32,
    pub outbound_mismatches: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ObservedTrace {
    #[schemars(range(min = 1, max = 1))]
    #[serde(deserialize_with = "version_one")]
    pub v: u32,
    pub target: String,
    pub scenario: String,
    pub outcome: Outcome,
    pub events: Vec<ObservedEvent>,
    pub streams: BTreeMap<String, StreamReport>,
    pub incomplete: bool,
}

impl<'de> Deserialize<'de> for ExpectedEvent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let mut value = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let id = value
            .remove("id")
            .ok_or_else(|| D::Error::missing_field("id"))?;
        Ok(Self {
            id: serde_json::from_value(id).map_err(D::Error::custom)?,
            event: serde_json::from_value(value.into()).map_err(D::Error::custom)?,
        })
    }
}
impl<'de> Deserialize<'de> for ObservedEvent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let mut value = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let seq = value
            .remove("seq")
            .ok_or_else(|| D::Error::missing_field("seq"))?;
        Ok(Self {
            seq: serde_json::from_value(seq).map_err(D::Error::custom)?,
            event: serde_json::from_value(value.into()).map_err(D::Error::custom)?,
        })
    }
}

pub fn version_one<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = u32::deserialize(d)?;
    if v == 1 {
        Ok(v)
    } else {
        Err(serde::de::Error::custom("version must be 1"))
    }
}

fn event_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
    field: &str,
) -> schemars::schema::Schema {
    use schemars::schema::{InstanceType, Schema, SchemaObject, SingleOrVec};
    let mut schema = TraceEvent::json_schema(generator);
    if let Schema::Object(ref mut obj) = schema
        && let Some(sub) = &mut obj.subschemas
        && let Some(variants) = &mut sub.one_of
    {
        for variant in variants {
            if let Schema::Object(SchemaObject {
                object: Some(object),
                ..
            }) = variant
            {
                let field_type = if field == "id" {
                    InstanceType::String
                } else {
                    InstanceType::Integer
                };
                object.properties.insert(
                    field.into(),
                    Schema::Object(SchemaObject {
                        instance_type: Some(SingleOrVec::Single(Box::new(field_type))),
                        ..Default::default()
                    }),
                );
                object.required.insert(field.into());
            }
        }
    }
    schema
}
impl JsonSchema for ExpectedEvent {
    fn schema_name() -> String {
        "ExpectedEvent".into()
    }
    fn json_schema(g: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        event_schema(g, "id")
    }
}
impl JsonSchema for ObservedEvent {
    fn schema_name() -> String {
        "ObservedEvent".into()
    }
    fn json_schema(g: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        event_schema(g, "seq")
    }
}
