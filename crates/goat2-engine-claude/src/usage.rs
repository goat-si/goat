//! Context usage for the live meter (v1 `ClaudeContextUsage.ts`, `ClaudeCompactSettings.ts`,
//! `ClaudeReportedContext.ts` and `emitContextUsage` in `ClaudeAdapterV2.ts:2779-2830` at
//! `916b5ccc1b2`).
//!
//! `usedTokens` is the size of the current request's context (input + cache + output of the
//! latest root message), not a session total; `maxTokens` is the model's context window and
//! `autoCompactThreshold` the point Claude compacts at. An update without input is a placeholder
//! and is skipped. Cost is Claude's `total_cost_usd`, only when a result reports it.

use std::path::{Path, PathBuf};

use goat2_contracts::{ThreadTokenUsageSnapshot, TokenUsageCost};
use serde_json::{Map, Value};

/// v1 CLAUDE_AUTO_COMPACT_RESERVE_TOKENS: Claude compacts 33,000 tokens short of the window.
const AUTO_COMPACT_RESERVE_TOKENS: u64 = 33_000;
/// v1 MAX_REPORTED_MODELS.
const MAX_REPORTED_MODELS: usize = 128;

/// The last measurement of a turn: a message's usage or a bare token count (after compaction).
#[derive(Debug, Clone, PartialEq)]
pub enum UsageSample {
    Message(Value),
    Count(u64),
}

/// v1 optionalClaudeUsageTokenCount: a finite, non-negative number, rounded.
pub fn token_count(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number >= 0.0).then(|| number.round() as u64)
}

/// v1 claudeMessageInputTokens.
pub fn message_input_tokens(usage: &Value) -> u64 {
    [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .map(|key| token_count(usage.get(*key)).unwrap_or(0))
    .sum()
}

/// v1 mergeClaudeStreamUsage: `message_delta` usage is per-message cumulative; absent or null
/// fields keep the `message_start` values.
pub fn merge_stream_usage(current: &Value, delta: &Value) -> Value {
    let mut merged = current.as_object().cloned().unwrap_or_default();
    if let Some(iterations) = delta.get("iterations").filter(|v| !v.is_null()) {
        merged.insert("iterations".into(), iterations.clone());
    }
    for (key, fallback) in [
        ("input_tokens", Value::from(0)),
        ("cache_creation_input_tokens", Value::Null),
        ("cache_read_input_tokens", Value::Null),
        ("output_tokens", Value::from(0)),
    ] {
        let value = token_count(delta.get(key))
            .or_else(|| token_count(current.get(key)))
            .map(Value::from)
            .unwrap_or(fallback);
        merged.insert(key.into(), value);
    }
    Value::Object(merged)
}

/// v1 claudeAutoCompactThreshold: a window at or above the model's context never applies.
pub fn auto_compact_threshold(window: Option<u64>, max_tokens: Option<u64>) -> Option<u64> {
    let window = window.filter(|w| *w > 0)?;
    if max_tokens.is_some_and(|max| window >= max) {
        return None;
    }
    window
        .checked_sub(AUTO_COMPACT_RESERVE_TOKENS)
        .filter(|threshold| *threshold > 0)
}

fn empty_snapshot(used_tokens: u64) -> ThreadTokenUsageSnapshot {
    ThreadTokenUsageSnapshot {
        used_tokens,
        total_processed_tokens: None,
        max_tokens: None,
        input_tokens: None,
        cached_input_tokens: None,
        output_tokens: None,
        reasoning_output_tokens: None,
        last_used_tokens: None,
        last_input_tokens: None,
        last_cached_input_tokens: None,
        last_output_tokens: None,
        last_reasoning_output_tokens: None,
        tool_uses: None,
        duration_ms: None,
        auto_compact_threshold: None,
        compacts_automatically: None,
        cost: None,
    }
}

/// v1 claudeProviderTurnTokenUsage, or the bare-count form of emitContextUsage. None for usage
/// without input (v1 skips `inputTokens <= 0`). The `last*` fields carry the same request's
/// numbers.
pub fn snapshot(
    sample: &UsageSample,
    max_tokens: Option<u64>,
    auto_compact_window: Option<u64>,
) -> Option<ThreadTokenUsageSnapshot> {
    let max_tokens = max_tokens.filter(|max| *max > 0);
    let threshold = auto_compact_threshold(auto_compact_window, max_tokens);
    match sample {
        UsageSample::Count(count) => {
            let mut snapshot = empty_snapshot(*count);
            snapshot.max_tokens = max_tokens;
            snapshot.auto_compact_threshold = threshold;
            Some(snapshot)
        }
        UsageSample::Message(usage) => {
            // After an advisor call the totals can count the same context twice; v1 takes the
            // last "message" iteration.
            let sample = usage
                .get("iterations")
                .and_then(Value::as_array)
                .and_then(|iterations| {
                    iterations
                        .iter()
                        .rev()
                        .find(|i| i.get("type").and_then(Value::as_str) == Some("message"))
                })
                .unwrap_or(usage);
            let input = message_input_tokens(sample);
            if input == 0 {
                return None;
            }
            let output = token_count(sample.get("output_tokens")).unwrap_or(0);
            let cached = token_count(sample.get("cache_read_input_tokens")).unwrap_or(0);
            let used = input.saturating_add(output);
            let mut snapshot = empty_snapshot(used);
            snapshot.max_tokens = max_tokens;
            snapshot.input_tokens = Some(input);
            snapshot.cached_input_tokens = Some(cached);
            snapshot.output_tokens = Some(output);
            snapshot.reasoning_output_tokens = Some(0);
            snapshot.last_used_tokens = Some(used);
            snapshot.last_input_tokens = Some(input);
            snapshot.last_cached_input_tokens = Some(cached);
            snapshot.last_output_tokens = Some(output);
            snapshot.last_reasoning_output_tokens = Some(0);
            snapshot.auto_compact_threshold = threshold;
            Some(snapshot)
        }
    }
}

/// Claude's `total_cost_usd` from a result, when it reports one.
pub fn result_cost(result: &Value) -> Option<TokenUsageCost> {
    let amount = result.get("total_cost_usd")?.as_f64()?;
    if !amount.is_finite() || amount < 0.0 {
        return None;
    }
    Some(TokenUsageCost {
        amount: serde_json::Number::from_f64(amount)?,
        currency: "USD".to_string(),
    })
}

/// v1 createClaudeReportedContext: context windows a result's `modelUsage` reported, per API
/// model id. Returns whether anything changed.
pub fn record_reported_windows(
    windows: &mut std::collections::HashMap<String, u64>,
    model_usage: Option<&Value>,
) -> bool {
    let Some(models) = model_usage.and_then(Value::as_object) else {
        return false;
    };
    let mut changed = false;
    for (model, entry) in models {
        if model.len() > 256 {
            continue;
        }
        let Some(window) = entry
            .get("contextWindow")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 1.0)
            .map(|v| v.round() as u64)
        else {
            continue;
        };
        if windows.get(model) == Some(&window) {
            continue;
        }
        if !windows.contains_key(model) && windows.len() >= MAX_REPORTED_MODELS {
            continue;
        }
        windows.insert(model.clone(), window);
        changed = true;
    }
    changed
}

/// The context window the bundled catalog gives an API model id (v1
/// resolveClaudeCatalogContextWindowTokens). A model with a selectable window takes its `1m`
/// size only when the id carries the `[1m]` suffix; otherwise the window is left to what Claude
/// reports, since GOAT 2 passes the model id through without the catalog's suffixes.
pub fn catalog_context_window(api_model_id: &str) -> Option<u64> {
    let manifest: Value = serde_json::from_str(crate::probe::MANIFEST).ok()?;
    let trimmed = api_model_id.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (base, one_million) = match lower.strip_suffix("[1m]") {
        Some(base) => (base.to_string(), true),
        None => (lower.clone(), false),
    };
    let model = manifest.get("models")?.as_array()?.iter().find(|model| {
        model
            .get("slug")
            .and_then(Value::as_str)
            .is_some_and(|slug| slug.eq_ignore_ascii_case(&base))
            || model
                .get("aliases")
                .and_then(Value::as_array)
                .is_some_and(|aliases| {
                    aliases
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|alias| alias.eq_ignore_ascii_case(&base))
                })
    })?;
    let profile = model.get("profile")?.as_str()?;
    let runtime = manifest.pointer(&format!("/profiles/{profile}/adapter/claudeCode"))?;
    if let Some(fixed) = runtime
        .get("fixedContextWindowTokens")
        .and_then(Value::as_u64)
    {
        return Some(fixed);
    }
    if one_million {
        return runtime
            .pointer("/contextWindowTokens/1m")
            .and_then(Value::as_u64);
    }
    None
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

fn settings_env(settings: &Value, key: &str) -> Option<String> {
    field(field(settings, "env")?, key)?
        .as_str()
        .map(str::to_owned)
}

/// v1 windowFrom: a per-model `modelSettings.<model>.autoCompactWindow` ("auto" clears it), else
/// the top-level `autoCompactWindow`, each an integer in 100,000..=1,000,000.
fn window_from(settings: &Value, model: &str) -> Option<Option<u64>> {
    let valid = |value: Option<&Value>| {
        value
            .and_then(Value::as_u64)
            .filter(|v| (100_000..=1_000_000).contains(v))
    };
    let model_window = field(settings, "modelSettings")
        .and_then(|m| field(m, model))
        .and_then(|m| field(m, "autoCompactWindow"));
    if model_window.and_then(Value::as_str) == Some("auto") {
        return Some(None);
    }
    valid(model_window)
        .or_else(|| valid(field(settings, "autoCompactWindow")))
        .map(Some)
}

/// Claude settings files, most specific first (v1 settingsFilesByPrecedence: local, project,
/// then the Claude home's user settings). v1 also looks for `settings.local.json` at the
/// repository root; GOAT 2 reads it from the working directory only.
pub fn settings_files(cwd: &str, config_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !cwd.is_empty() {
        let dir = Path::new(cwd).join(".claude");
        files.push(dir.join("settings.local.json"));
        files.push(dir.join("settings.json"));
    }
    files.push(config_dir.join("settings.json"));
    files
}

/// v1 resolveAutoCompactWindow (`ClaudeCompactSettings.ts:39-91`) without the GOAT-side
/// setting, which GOAT 2 does not have: disabled compaction (`autoCompactEnabled: false`,
/// `DISABLE_COMPACT`, `DISABLE_AUTO_COMPACT`) gives None; otherwise
/// `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then the settings window. Settings env beats the process
/// env; launch settings beat the files.
pub fn resolve_auto_compact_window(
    model: &str,
    launch_settings: &Map<String, Value>,
    files: &[PathBuf],
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<u64> {
    let model = {
        let lower = model.to_ascii_lowercase();
        if lower.ends_with("[1m]") {
            model[..model.len() - 4].to_string()
        } else {
            model.to_string()
        }
    };
    let names = [
        "DISABLE_COMPACT",
        "DISABLE_AUTO_COMPACT",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    ];
    let launch = Value::Object(launch_settings.clone());
    let mut found: Vec<Option<String>> = names.iter().map(|n| settings_env(&launch, n)).collect();
    let mut enabled = field(&launch, "autoCompactEnabled").and_then(Value::as_bool);
    let mut window = window_from(&launch, &model);
    for file in files {
        if enabled.is_some() && window.is_some() && found.iter().all(Option::is_some) {
            break;
        }
        let Some(settings) = std::fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        else {
            continue;
        };
        for (slot, name) in found.iter_mut().zip(names) {
            if slot.is_none() {
                *slot = settings_env(&settings, name);
            }
        }
        if enabled.is_none() {
            enabled = field(&settings, "autoCompactEnabled").and_then(Value::as_bool);
        }
        if window.is_none() {
            window = window_from(&settings, &model);
        }
    }
    let lookup = |index: usize| found[index].clone().or_else(|| env(names[index]));
    let truthy = |value: Option<String>| {
        value.is_some_and(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
    };
    if enabled == Some(false) || truthy(lookup(0)) || truthy(lookup(1)) {
        return None;
    }
    if let Some(numeric) = lookup(2)
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| (100_000..=1_000_000).contains(v))
    {
        return Some(numeric);
    }
    window.flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn catalog_windows() {
        assert_eq!(catalog_context_window("claude-opus-5-5"), Some(1_000_000));
        assert_eq!(catalog_context_window("opus"), Some(1_000_000));
        assert_eq!(catalog_context_window("claude-haiku-4-5"), Some(200_000));
        assert_eq!(
            catalog_context_window("claude-sonnet-4-6[1m]"),
            Some(1_000_000)
        );
        assert_eq!(catalog_context_window("claude-sonnet-4-6"), None);
        assert_eq!(catalog_context_window("not-a-model"), None);
    }

    #[test]
    fn threshold_needs_a_window_below_the_context() {
        assert_eq!(
            auto_compact_threshold(Some(150_000), Some(200_000)),
            Some(117_000)
        );
        assert_eq!(auto_compact_threshold(Some(200_000), Some(200_000)), None);
        assert_eq!(auto_compact_threshold(None, Some(200_000)), None);
        assert_eq!(auto_compact_threshold(Some(150_000), None), Some(117_000));
    }

    #[test]
    fn auto_compact_window_precedence() {
        let dir = std::env::temp_dir().join(format!("goat2-claude-usage-{}", crate::util::uuid()));
        let cwd = dir.join("project");
        let home = dir.join("home");
        std::fs::create_dir_all(cwd.join(".claude")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let files = settings_files(cwd.to_str().unwrap(), &home);
        let write = |path: PathBuf, value: Value| std::fs::write(path, value.to_string()).unwrap();
        let launch = Map::new();
        let model = "claude-opus-4-5";

        write(
            home.join("settings.json"),
            serde_json::json!({"autoCompactWindow": 300_000}),
        );
        assert_eq!(
            resolve_auto_compact_window(model, &launch, &files, &no_env),
            Some(300_000)
        );

        write(
            cwd.join(".claude/settings.json"),
            serde_json::json!({"modelSettings": {model: {"autoCompactWindow": 250_000}}}),
        );
        assert_eq!(
            resolve_auto_compact_window(model, &launch, &files, &no_env),
            Some(250_000)
        );
        assert_eq!(
            resolve_auto_compact_window(&format!("{model}[1m]"), &launch, &files, &no_env),
            Some(250_000),
            "the [1m] suffix is not part of the model key"
        );

        write(
            cwd.join(".claude/settings.local.json"),
            serde_json::json!({"modelSettings": {model: {"autoCompactWindow": "auto"}}}),
        );
        assert_eq!(
            resolve_auto_compact_window(model, &launch, &files, &no_env),
            None
        );

        let env =
            |name: &str| (name == "CLAUDE_CODE_AUTO_COMPACT_WINDOW").then(|| "500000".to_string());
        assert_eq!(
            resolve_auto_compact_window(model, &launch, &files, &env),
            Some(500_000)
        );

        let mut settings_env = Map::new();
        settings_env.insert(
            "env".into(),
            serde_json::json!({"DISABLE_AUTO_COMPACT": "1"}),
        );
        assert_eq!(
            resolve_auto_compact_window(model, &settings_env, &files, &env),
            None
        );

        let mut disabled = Map::new();
        disabled.insert("autoCompactEnabled".into(), Value::Bool(false));
        assert_eq!(
            resolve_auto_compact_window(model, &disabled, &files, &env),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn placeholder_usage_is_skipped_and_iterations_pick_the_last_message() {
        assert!(
            snapshot(
                &UsageSample::Message(serde_json::json!({"output_tokens": 3})),
                None,
                None
            )
            .is_none()
        );
        let usage = serde_json::json!({
            "input_tokens": 9000, "output_tokens": 10,
            "iterations": [
                {"type": "message", "input_tokens": 100, "output_tokens": 5},
                {"type": "advisor", "input_tokens": 7000},
                {"type": "message", "input_tokens": 200, "cache_read_input_tokens": 50, "output_tokens": 7}
            ]
        });
        let snap = snapshot(&UsageSample::Message(usage), Some(200_000), None).unwrap();
        assert_eq!(snap.used_tokens, 257);
        assert_eq!(snap.cached_input_tokens, Some(50));
    }
}
