//! Encoding and strict decoding of `goat.jsonl` lines.

use serde_json::Value;

use crate::contract::{LOG_FORMAT_VERSION, LogEvent, LogLine};

/// A decoded event line.
#[derive(Debug, Clone)]
pub enum Parsed {
    Event(Box<LogLine>),
    /// A v1 line with an event type this build does not know. Format rule (v1 freeze): readers skip
    /// new event types; the fold only advances `appliedSeq`.
    Skip {
        seq: u64,
    },
    /// A line with `v` above [LOG_FORMAT_VERSION]: this build cannot read the thread further.
    Unsupported {
        seq: u64,
        v: u64,
        kind: String,
    },
}

impl Parsed {
    pub fn seq(&self) -> u64 {
        match self {
            Parsed::Event(line) => line.seq,
            Parsed::Skip { seq, .. } | Parsed::Unsupported { seq, .. } => *seq,
        }
    }
}

pub fn encode(line: &LogLine) -> serde_json::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(line)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Decode one line (without its newline). A known type that does not decode is an error, never
/// "unknown".
pub fn decode(bytes: &[u8]) -> Result<Parsed, String> {
    if let Ok(line) = serde_json::from_slice::<LogLine>(bytes)
        && line.v == LOG_FORMAT_VERSION
        && line.seq > 0
    {
        return Ok(Parsed::Event(Box::new(line)));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|e| format!("not JSON: {e}"))?;
    let obj = value.as_object().ok_or("line is not a JSON object")?;
    let v = obj
        .get("v")
        .and_then(Value::as_u64)
        .ok_or("line has no numeric v")?;
    let seq = obj
        .get("seq")
        .and_then(Value::as_u64)
        .ok_or("line has no numeric seq")?;
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or("line has no type")?
        .to_owned();
    if seq == 0 {
        return Err("seq is 0".into());
    }
    if v > u64::from(LOG_FORMAT_VERSION) {
        return Ok(Parsed::Unsupported { seq, v, kind });
    }
    if v == 0 {
        return Err(format!("line {seq} has v 0"));
    }
    if !LogEvent::TYPE_TAGS.contains(&kind.as_str()) {
        return Ok(Parsed::Skip { seq });
    }
    let detail = serde_json::from_slice::<LogLine>(bytes)
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default();
    Err(format!("{kind} line {seq} does not decode: {detail}"))
}

/// True when a checkpoint line's raw `fold` object has every key in [crate::contract::FOLD_KEYS].
pub fn checkpoint_is_complete(bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let Some(fold) = value.get("fold").and_then(Value::as_object) else {
        return false;
    };
    crate::contract::FOLD_KEYS
        .iter()
        .all(|key| fold.contains_key(*key))
}
