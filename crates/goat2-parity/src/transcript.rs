//! Parsing and provenance checks for v1 provider replay transcripts.
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Record {
    #[serde(rename = "transcript_start")]
    Start {
        provider: String,
        protocol: String,
        version: String,
        scenario: String,
        metadata: Option<serde_json::Map<String, Value>>,
    },
    #[serde(rename = "expect_outbound")]
    ExpectOutbound { label: Option<String>, frame: Value },
    #[serde(rename = "emit_inbound")]
    EmitInbound {
        label: Option<String>,
        frame: Value,
        #[serde(rename = "afterMs")]
        after_ms: Option<u64>,
    },
    #[serde(rename = "runtime_exit")]
    RuntimeExit {
        status: ExitStatus,
        error: Option<Value>,
    },
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitStatus {
    Success,
    Error,
    Cancelled,
}
#[derive(Debug, thiserror::Error)]
pub enum TranscriptError {
    #[error("line {line}: {message}")]
    Invalid { line: usize, message: String },
    #[error("sha256 mismatch: expected {expected}, got {actual}")]
    Hash { expected: String, actual: String },
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn verify_hash(bytes: &[u8], expected: &str) -> Result<(), TranscriptError> {
    let actual = sha256(bytes);
    if actual != expected {
        return Err(TranscriptError::Hash {
            expected: expected.to_owned(),
            actual,
        });
    }
    Ok(())
}
pub fn parse(bytes: &[u8]) -> Result<Vec<Record>, TranscriptError> {
    let input = std::str::from_utf8(bytes).map_err(|e| TranscriptError::Invalid {
        line: 1,
        message: e.to_string(),
    })?;
    let mut records = Vec::new();
    for (i, line) in input.lines().enumerate() {
        let record: Record = serde_json::from_str(line).map_err(|e| TranscriptError::Invalid {
            line: i + 1,
            message: e.to_string(),
        })?;
        match &record {
            Record::Start {
                provider,
                protocol,
                version,
                scenario,
                ..
            } if i == 0
                && [provider, protocol, version, scenario]
                    .iter()
                    .all(|s| !s.trim().is_empty()) => {}
            Record::Start { .. } => {
                return Err(TranscriptError::Invalid {
                    line: i + 1,
                    message: "header must be first and nonempty".into(),
                });
            }
            _ if i == 0 => {
                return Err(TranscriptError::Invalid {
                    line: 1,
                    message: "missing transcript_start".into(),
                });
            }
            Record::ExpectOutbound {
                label: Some(label), ..
            }
            | Record::EmitInbound {
                label: Some(label), ..
            } if label.trim().is_empty() => {
                return Err(TranscriptError::Invalid {
                    line: i + 1,
                    message: "empty label".into(),
                });
            }
            _ => {}
        }
        records.push(record);
    }
    if records.is_empty() {
        return Err(TranscriptError::Invalid {
            line: 1,
            message: "empty transcript".into(),
        });
    }
    Ok(records)
}
pub fn outbound_count(records: &[Record]) -> usize {
    records
        .iter()
        .filter(|r| matches!(r, Record::ExpectOutbound { .. }))
        .count()
}
