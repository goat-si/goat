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
