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

/// The signed counterpart of [safe_u64]: values stay within +/- [crate::limits::MAX_SAFE_WIRE_INTEGER].
pub mod safe_i64 {
    use serde::{Deserialize, Deserializer, Serializer, de, ser};

    use crate::limits::MAX_SAFE_WIRE_INTEGER;

    fn in_range(value: i64) -> bool {
        value.unsigned_abs() <= MAX_SAFE_WIRE_INTEGER
    }

    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        if !in_range(*value) {
            return Err(<S::Error as ser::Error>::custom(format!(
                "{value} is outside the safe wire integer range"
            )));
        }
        serializer.serialize_i64(*value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        let value = i64::deserialize(deserializer)?;
        if !in_range(value) {
            return Err(<D::Error as de::Error>::custom(format!(
                "{value} is outside the safe wire integer range"
            )));
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

/// v1 `BotInstructions`: at most 16384 characters and 16384 UTF-8 bytes, checked when reading and
/// writing. JSON Schema can only express the character limit; the byte limit is serde-only.
pub mod instructions {
    use serde::{Deserialize, Deserializer, Serializer, de, ser};

    use crate::limits::BOT_INSTRUCTIONS_MAX_BYTES;

    fn check(value: &str) -> Result<(), String> {
        if value.chars().count() > BOT_INSTRUCTIONS_MAX_BYTES
            || value.len() > BOT_INSTRUCTIONS_MAX_BYTES
        {
            return Err(format!(
                "bot instructions must fit in {BOT_INSTRUCTIONS_MAX_BYTES} characters and UTF-8 bytes"
            ));
        }
        Ok(())
    }

    pub fn serialize<S: Serializer>(
        value: &Option<String>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(text) => {
                check(text).map_err(<S::Error as ser::Error>::custom)?;
                serializer.serialize_some(text)
            }
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<String>, D::Error> {
        let value = Option::<String>::deserialize(deserializer)?;
        if let Some(text) = &value {
            check(text).map_err(<D::Error as de::Error>::custom)?;
        }
        Ok(value)
    }
}

/// v1 `SignInUrl` (`providerSetup.ts`): trimmed, non-empty, at most 16384 characters, and
/// `http(s)://` only, because clients open it. Checked when reading and writing; the JSON Schema
/// carries the same pattern and length.
pub mod sign_in_url {
    use serde::{Deserialize, Deserializer, Serializer, de, ser};

    pub const MAX_CHARS: usize = 16_384;

    pub fn check(value: &str) -> Result<(), String> {
        let lower = value.get(..8).unwrap_or(value).to_ascii_lowercase();
        let http = lower.starts_with("http://") || lower.starts_with("https://");
        if value.is_empty() || value.trim() != value || value.chars().count() > MAX_CHARS || !http {
            return Err(
                "a sign-in URL must be a trimmed http(s) URL of at most 16384 characters".into(),
            );
        }
        Ok(())
    }

    pub fn serialize<S: Serializer>(value: &str, serializer: S) -> Result<S::Ok, S::Error> {
        check(value).map_err(<S::Error as ser::Error>::custom)?;
        serializer.serialize_str(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
        let value = String::deserialize(deserializer)?;
        check(&value).map_err(<D::Error as de::Error>::custom)?;
        Ok(value)
    }
}

/// [sign_in_url] for nullable fields (combine with `default`).
pub mod sign_in_url_opt {
    use serde::{Deserialize, Deserializer, Serializer, de, ser};

    pub fn serialize<S: Serializer>(
        value: &Option<String>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(url) => {
                super::sign_in_url::check(url).map_err(<S::Error as ser::Error>::custom)?;
                serializer.serialize_some(url)
            }
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<String>, D::Error> {
        let value = Option::<String>::deserialize(deserializer)?;
        if let Some(url) = &value {
            super::sign_in_url::check(url).map_err(<D::Error as de::Error>::custom)?;
        }
        Ok(value)
    }
}

/// `RequestOpened.context`: at most [crate::limits::REQUEST_CONTEXT_MAX_CHARS] characters, checked
/// when reading and writing; the JSON Schema carries the same `maxLength`.
pub mod request_context {
    use serde::{Deserialize, Deserializer, Serializer, de, ser};

    use crate::limits::REQUEST_CONTEXT_MAX_CHARS;

    fn check(value: &str) -> Result<(), String> {
        if value.chars().count() > REQUEST_CONTEXT_MAX_CHARS {
            return Err(format!(
                "context must be at most {REQUEST_CONTEXT_MAX_CHARS} characters"
            ));
        }
        Ok(())
    }

    pub fn serialize<S: Serializer>(
        value: &Option<String>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(text) => {
                check(text).map_err(<S::Error as ser::Error>::custom)?;
                serializer.serialize_some(text)
            }
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<String>, D::Error> {
        let value = Option::<String>::deserialize(deserializer)?;
        if let Some(text) = &value {
            check(text).map_err(<D::Error as de::Error>::custom)?;
        }
        Ok(value)
    }
}

#[cfg(test)]
mod part2_tests {
    use crate::*;

    fn bot(instructions: Option<String>) -> BotProfile {
        BotProfile {
            bot_id: BotId::from("bot-1"),
            name: "Bot".into(),
            purpose: String::new(),
            face: BotFace {
                shape: "round".into(),
                color: "blue".into(),
                goat: false,
            },
            role: BotRole::Member,
            session_thread_id: ThreadId::from("thr-1"),
            default_model_selection: ModelSelection {
                instance_id: ProviderInstanceId::from("codex"),
                model: "gpt".into(),
                options: None,
            },
            instructions,
        }
    }

    #[test]
    fn instructions_enforce_characters_and_bytes_both_ways() {
        let at_limit = "a".repeat(crate::limits::BOT_INSTRUCTIONS_MAX_BYTES);
        let json = serde_json::to_value(bot(Some(at_limit.clone()))).unwrap();
        assert_eq!(
            serde_json::from_value::<BotProfile>(json)
                .unwrap()
                .instructions,
            Some(at_limit)
        );

        // 8193 two-byte characters: within the character limit the schema checks, over the byte limit.
        let multibyte = "\u{e9}".repeat(8193);
        assert!(serde_json::to_value(bot(Some(multibyte.clone()))).is_err());
        let mut json = serde_json::to_value(bot(None)).unwrap();
        json["instructions"] = serde_json::Value::String(multibyte);
        assert!(serde_json::from_value::<BotProfile>(json).is_err());
    }

    #[test]
    fn sign_in_urls_are_http_only_both_ways() {
        use crate::serde_util::sign_in_url::check;
        assert!(check("https://auth.example.com/x").is_ok());
        assert!(check("HTTP://auth.example.com/x").is_ok());
        assert!(check("javascript:alert(1)").is_err());
        assert!(check(" https://padded.example.com").is_err());
        assert!(check("").is_err());
        let state = ProviderAuthState {
            instance_id: ProviderInstanceId::from("codex"),
            phase: ProviderAuthPhase::Waiting,
            flow_id: None,
            authorization_url: Some("javascript:alert(1)".into()),
            expires_at: None,
            message: None,
            methods: None,
            interaction: None,
            credential_owner: None,
        };
        assert!(serde_json::to_value(&state).is_err());
    }
}
