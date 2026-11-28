//! Effect Schema checks used by v1's ACP registry contracts, with Effect 4.0.5's messages.
//!
//! v1 decodes with Effect Schema (`packages/contracts/src/baseSchemas.ts:14-29` for the trimmed
//! strings; Effect `Schema.ts:8525-8550` `isMaxLength`, `SchemaAST.ts:4312-4330` `isPattern`,
//! `Schema.ts:7636` `isBetween`, `Schema.ts:7924` `isInt`). Lengths are JavaScript string lengths
//! (UTF-16 code units). A failed check reports "Expected " plus Effect's `expected` text, or the
//! message a v1 filter returns, then the path in Effect's `at ["key"]` form.

use std::fmt;

use regex::Regex;
use serde_json::Value;

/// One failed check, at a field path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError {
    pub path: Vec<String>,
    pub message: String,
}

impl SchemaError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            path: Vec::new(),
            message: message.into(),
        }
    }
    /// Prefix a field or index (the innermost key is added first).
    pub fn at(mut self, key: impl Into<String>) -> Self {
        self.path.insert(0, key.into());
        self
    }
}

impl fmt::Display for SchemaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)?;
        if !self.path.is_empty() {
            f.write_str("\n  at ")?;
            for key in &self.path {
                match key.parse::<usize>() {
                    Ok(index) => write!(f, "[{index}]")?,
                    Err(_) => write!(f, "[{}]", Value::String(key.clone()))?,
                }
            }
        }
        Ok(())
    }
}

impl std::error::Error for SchemaError {}

pub type Checked<T> = Result<T, SchemaError>;

/// JavaScript `String.prototype.length`.
pub fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// JavaScript `String.prototype.trim` (Unicode white space plus U+FEFF).
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn got(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// Effect's type mismatch: `Expected <type>, got <input>`.
pub fn type_error(expected: &str, value: &Value) -> SchemaError {
    SchemaError::new(format!("Expected {expected}, got {}", got(value)))
}

pub fn max_len(value: &str, max: usize) -> Checked<()> {
    if js_len(value) <= max {
        Ok(())
    } else {
        Err(SchemaError::new(format!(
            "Expected a value with a length of at most {max}, got {}",
            Value::String(value.into())
        )))
    }
}

pub fn min_len(value: &str, min: usize) -> Checked<()> {
    if js_len(value) >= min {
        Ok(())
    } else {
        Err(SchemaError::new(format!(
            "Expected a value with a length of at least {min}, got {}",
            Value::String(value.into())
        )))
    }
}

pub fn max_items<T>(items: &[T], max: usize) -> Checked<()> {
    if items.len() <= max {
        Ok(())
    } else {
        Err(SchemaError::new(format!(
            "Expected a value with a length of at most {max}"
        )))
    }
}

/// `Schema.isPattern`: `source` is v1's JavaScript RegExp source, `pattern` its Rust form.
pub fn pattern(value: &str, source: &str, pattern: &str) -> Checked<()> {
    if Regex::new(pattern).expect("static regex").is_match(value) {
        Ok(())
    } else {
        Err(SchemaError::new(format!(
            "Expected a string matching the RegExp {source}, got {}",
            Value::String(value.into())
        )))
    }
}

/// v1 `baseSchemas.ts:23-29` `isNonBlank`.
pub fn non_blank(value: &str) -> Checked<()> {
    if js_trim(value).is_empty() {
        Err(SchemaError::new(format!(
            "Expected a non-blank string, got {}",
            Value::String(value.into())
        )))
    } else {
        Ok(())
    }
}

/// Trim in place, as v1's `TrimmedString` decode does.
pub fn trim_in_place(value: &mut String) {
    let trimmed = js_trim(value);
    if trimmed.len() != value.len() {
        *value = trimmed.to_owned();
    }
}

/// `TrimmedNonEmptyString`, optionally with `isMaxLength(max)`.
pub fn trimmed_non_empty(value: &mut String, max: Option<usize>) -> Checked<()> {
    trim_in_place(value);
    non_blank(value)?;
    if let Some(max) = max {
        max_len(value, max)?;
    }
    Ok(())
}

/// Run `check` on a field and prefix its key on failure.
pub fn field<T>(key: &str, check: impl FnOnce() -> Checked<T>) -> Checked<T> {
    check().map_err(|e| e.at(key))
}

/// Run `check` on each element and prefix the index on failure.
pub fn each<T>(items: &mut [T], mut check: impl FnMut(&mut T) -> Checked<()>) -> Checked<()> {
    for (index, item) in items.iter_mut().enumerate() {
        check(item).map_err(|e| e.at(index.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_follow_effect() {
        assert_eq!(
            max_len("abc", 2).unwrap_err().message,
            "Expected a value with a length of at most 2, got \"abc\""
        );
        // UTF-16 length, as JavaScript counts it.
        assert!(max_len("😀", 1).is_err());
        assert_eq!(
            non_blank("  ").unwrap_err().message,
            "Expected a non-blank string, got \"  \""
        );
        let e = field("agents", || each(&mut ["x".to_string()], |s| max_len(s, 0))).unwrap_err();
        assert_eq!(
            e.to_string(),
            "Expected a value with a length of at most 0, got \"x\"\n  at [\"agents\"][0]"
        );
        let mut s = "  a ".to_string();
        trimmed_non_empty(&mut s, Some(1)).unwrap();
        assert_eq!(s, "a");
        assert_eq!(
            pattern("A", "^[a-z]$", "^[a-z]$").unwrap_err().message,
            "Expected a string matching the RegExp ^[a-z]$, got \"A\""
        );
    }
}
