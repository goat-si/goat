//! Field helpers that keep JSON `null` distinct from an absent field.

use serde::{Deserialize, Deserializer};

/// For `Option<serde_json::Value>` fields with `#[serde(default)]`: an absent field is `None`,
/// an explicit `null` is `Some(Value::Null)` (v1 `Schema.optional(Schema.Unknown)`).
pub fn present_value<'de, D>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    serde_json::Value::deserialize(deserializer).map(Some)
}

/// For `Option<Option<T>>` fields with `#[serde(default)]`: absent is `None`, `null` is
/// `Some(None)`, a value is `Some(Some(v))` (v1 `Schema.optional(Schema.NullOr(T))`).
pub fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Enforces [crate::limits::MAX_SAFE_WIRE_INTEGER] on a `u64` wire field in both directions, so
/// Rust never writes or accepts a counter JavaScript cannot represent exactly. Use with
/// `#[serde(with = "crate::serde_util::safe_u64")]`.
pub mod safe_u64 {
    use serde::{Deserialize, Deserializer, Serializer, de, ser};

    use crate::limits::MAX_SAFE_WIRE_INTEGER;

    fn message(value: u64) -> String {
        format!("{value} is above the safe wire integer {MAX_SAFE_WIRE_INTEGER}")
    }

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        if *value > MAX_SAFE_WIRE_INTEGER {
            return Err(<S::Error as ser::Error>::custom(message(*value)));
        }
        serializer.serialize_u64(*value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = u64::deserialize(deserializer)?;
        if value > MAX_SAFE_WIRE_INTEGER {
            return Err(<D::Error as de::Error>::custom(message(value)));
        }
        Ok(value)
    }
}

/// [safe_u64] for `Option<u64>` fields (combine with `default` and `skip_serializing_if`).
pub mod safe_u64_opt {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(v) => super::safe_u64::serialize(v, serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        #[derive(Deserialize)]
        struct Wrap(#[serde(with = "super::safe_u64")] u64);
        Ok(Option::<Wrap>::deserialize(deserializer)?.map(|Wrap(v)| v))
    }
}

#[cfg(test)]
mod tests {
    use crate::limits::MAX_SAFE_WIRE_INTEGER;
    use crate::turn_item::PlanStep;
    use crate::*;
    use serde_json::json;

    fn line(seq: u64) -> LogLine {
        LogLine::new(
            seq,
            "2026-11-28T00:00:00Z",
            LogEvent::RunFinished(RunFinished {
                run_id: RunId::from("run-1"),
                outcome: RunOutcome::Completed,
                reason: None,
            }),
        )
    }

    #[test]
    fn max_safe_seq_round_trips_and_one_more_is_refused_both_ways() {
        let encoded = serde_json::to_value(line(MAX_SAFE_WIRE_INTEGER)).unwrap();
        assert_eq!(encoded["seq"], json!(9_007_199_254_740_991u64));
        let decoded: LogLine = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(decoded, line(MAX_SAFE_WIRE_INTEGER));

        assert!(serde_json::to_value(line(MAX_SAFE_WIRE_INTEGER + 1)).is_err());
        let mut too_big = encoded;
        too_big["seq"] = json!(MAX_SAFE_WIRE_INTEGER + 1);
        assert!(serde_json::from_value::<LogLine>(too_big).is_err());
    }

    #[test]
    fn optional_counters_keep_absent_and_enforce_the_bound() {
        let base = json!({"id": "s1", "text": "step", "status": "pending"});
        let step: PlanStep = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(step.duration_ms, None);
        assert_eq!(serde_json::to_value(&step).unwrap(), base);

        let mut ok = base.clone();
        ok["durationMs"] = json!(MAX_SAFE_WIRE_INTEGER);
        let step: PlanStep = serde_json::from_value(ok.clone()).unwrap();
        assert_eq!(serde_json::to_value(&step).unwrap(), ok);

        let mut bad = base;
        bad["durationMs"] = json!(MAX_SAFE_WIRE_INTEGER + 1);
        assert!(serde_json::from_value::<PlanStep>(bad).is_err());
        let step = PlanStep {
            duration_ms: Some(MAX_SAFE_WIRE_INTEGER + 1),
            ..step
        };
        assert!(serde_json::to_value(&step).is_err());
    }
}
