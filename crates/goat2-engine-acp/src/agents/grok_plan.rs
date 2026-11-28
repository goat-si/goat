//! The plan file Grok writes in plan mode, as a proposed-plan fallback.
//!
//! Ported from v1 `packages/provider-grok/src/server/xaiAcpExtension.ts:957-1090`
//! (`isGrokPlanMarkdownPath`, `grokPlanSessionPrefixes`, `extractGrokPlanMarkdownFromToolCallData`)
//! and the host it is called with in `packages/provider-grok/src/server/adapter.ts:451-461`.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::items::ToolState;

/// v1 `GrokPlanPathHost`.
#[derive(Debug, Clone, Default)]
pub struct GrokPlanPathHost {
    pub windows: bool,
    pub home: Option<String>,
    pub userprofile: Option<String>,
    pub grok_home: Option<String>,
    pub home_directory: String,
}

impl GrokPlanPathHost {
    /// The session's environment: the process environment with the launch variables on top (v1
    /// passes the environment captured when the session opened; its home is `HOME` or
    /// `USERPROFILE`, adapter.ts:452-460).
    pub fn for_session(launch_env: &[(String, String)]) -> Self {
        let read = |name: &str| {
            launch_env
                .iter()
                .rev()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .or_else(|| std::env::var(name).ok())
        };
        let home = read("HOME");
        let userprofile = read("USERPROFILE");
        Self {
            windows: cfg!(windows),
            home_directory: home
                .clone()
                .or_else(|| userprofile.clone())
                .unwrap_or_default(),
            home,
            userprofile,
            grok_home: read("GROK_HOME"),
        }
    }
}

/// v1 `normalizeFsPath`.
fn normalize_fs_path(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned()
}

/// v1 `addGrokSessionPrefix`.
fn add_prefix(prefixes: &mut BTreeSet<String>, root: &str, nested: bool) {
    let root = normalize_fs_path(root);
    if root.is_empty() {
        return;
    }
    prefixes.insert(if nested {
        format!("{root}/.grok/sessions/")
    } else {
        format!("{root}/sessions/")
    });
}

/// v1 `grokPlanSessionPrefixes` (xaiAcpExtension.ts:983-996).
fn session_prefixes(host: &GrokPlanPathHost) -> BTreeSet<String> {
    let mut prefixes = BTreeSet::new();
    add_prefix(&mut prefixes, &host.home_directory, true);
    add_prefix(&mut prefixes, "~", true);
    add_prefix(&mut prefixes, host.home.as_deref().unwrap_or(""), true);
    add_prefix(
        &mut prefixes,
        host.userprofile.as_deref().unwrap_or(""),
        true,
    );
    // ACP mock and isolated Grok spawns use a HOME that is not the server process home.
    add_prefix(&mut prefixes, "/tmp/mock-home", true);
    let grok_home = host.grok_home.as_deref().unwrap_or("");
    add_prefix(&mut prefixes, grok_home, false);
    add_prefix(&mut prefixes, grok_home, true);
    prefixes
}

const CANONICAL: &str =
    r"^(?:/home/[^/]+|/Users/[^/]+|[a-zA-Z]:/Users/[^/]+)/\.grok/sessions/(?:[^/]+/)+plan\.md$";
static CANONICAL_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(CANONICAL).expect("regex"));
static CANONICAL_PATH_CI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?i){CANONICAL}")).expect("regex"));

/// v1 `isGrokPlanMarkdownPath` (xaiAcpExtension.ts:1005-1035): a `plan.md` inside a Grok session
/// folder, never a project file and never a path that climbs out with `..`.
pub fn is_grok_plan_markdown_path(path: Option<&str>, host: &GrokPlanPathHost) -> bool {
    let Some(path) = path else {
        return false;
    };
    let normalized = path.trim().replace('\\', "/");
    let haystack = if host.windows {
        normalized.to_lowercase()
    } else {
        normalized.clone()
    };
    if normalized.is_empty()
        || !haystack.ends_with("/plan.md")
        || normalized.split('/').any(|segment| segment == "..")
    {
        return false;
    }
    for prefix in session_prefixes(host) {
        let needle = if host.windows {
            prefix.to_lowercase()
        } else {
            prefix
        };
        let Some(rest) = haystack.strip_prefix(&needle) else {
            continue;
        };
        if rest != "plan.md" && rest.ends_with("plan.md") {
            return true;
        }
    }
    if host.windows {
        CANONICAL_PATH_CI.is_match(&haystack)
    } else {
        CANONICAL_PATH.is_match(&haystack)
    }
}

/// v1 `extractGrokPlanMarkdownFromToolCallData` (xaiAcpExtension.ts:1037-1086): the trimmed plan a
/// tool call writes to the session plan file; `Some("")` when it writes an empty plan.
pub fn plan_markdown_from_tool_call(tool: &ToolState, host: &GrokPlanPathHost) -> Option<String> {
    let mut saw_plan_write = false;
    let mut take = |value: Option<&str>, path: Option<&str>| -> Option<String> {
        if !is_grok_plan_markdown_path(path, host) {
            return None;
        }
        let value = value?;
        saw_plan_write = true;
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    };
    if let Some(input) = tool.raw_input.as_ref().and_then(Value::as_object) {
        let path = input
            .get("file_path")
            .and_then(Value::as_str)
            .or_else(|| input.get("path").and_then(Value::as_str));
        let content = input.get("content").and_then(Value::as_str);
        if let Some(plan) = take(content, path) {
            return Some(plan);
        }
    }
    if let Some(Value::Array(blocks)) = &tool.content {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("diff") {
                continue;
            }
            let path = block.get("path").and_then(Value::as_str);
            let new_text = block.get("newText").and_then(Value::as_str);
            if let Some(plan) = take(new_text, path) {
                return Some(plan);
            }
        }
    }
    saw_plan_write.then(String::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn linux(home: &str) -> GrokPlanPathHost {
        GrokPlanPathHost {
            windows: false,
            home: Some(home.into()),
            home_directory: home.into(),
            ..Default::default()
        }
    }

    fn data(value: Value) -> ToolState {
        let mut tool = ToolState::default();
        tool.merge(&value);
        tool
    }

    /// v1 xaiAcpExtension.test.ts:1420-1553.
    #[test]
    fn plan_paths_are_session_files_only() {
        let host = linux("/home/me");
        let grok_home = GrokPlanPathHost {
            grok_home: Some("/opt/grok-data".into()),
            ..linux("/home/me")
        };
        let windows = GrokPlanPathHost {
            windows: true,
            ..grok_home.clone()
        };
        assert!(is_grok_plan_markdown_path(
            Some("/home/me/.grok/sessions/a/plan.md"),
            &host
        ));
        assert!(is_grok_plan_markdown_path(
            Some("/home/other/.grok/sessions/id/plan.md"),
            &host
        ));
        assert!(is_grok_plan_markdown_path(
            Some("/tmp/mock-home/.grok/sessions/s/plan.md"),
            &host
        ));
        assert!(is_grok_plan_markdown_path(
            Some("/opt/grok-data/sessions/sess/plan.md"),
            &grok_home
        ));
        assert!(!is_grok_plan_markdown_path(
            Some("/OPT/GROK-DATA/sessions/sess/plan.md"),
            &grok_home
        ));
        assert!(is_grok_plan_markdown_path(
            Some("/OPT/GROK-DATA/sessions/sess/plan.md"),
            &windows
        ));
        assert!(is_grok_plan_markdown_path(
            Some("C:\\Users\\other\\.grok\\sessions\\id\\plan.md"),
            &windows
        ));
        assert!(!is_grok_plan_markdown_path(Some("plan.md"), &host));
        assert!(!is_grok_plan_markdown_path(
            Some("/repo/docs/plan.md"),
            &host
        ));
        assert!(!is_grok_plan_markdown_path(
            Some("/repo/.grok/sessions/example/plan.md"),
            &host
        ));
        assert!(!is_grok_plan_markdown_path(
            Some("/home/me/project/.grok/sessions/example/plan.md"),
            &host
        ));
        assert!(!is_grok_plan_markdown_path(
            Some("/home/other/.grok/sessions/../../project/plan.md"),
            &host
        ));
        assert!(!is_grok_plan_markdown_path(
            Some("/home/me/.grok/sessions/plan.md"),
            &host
        ));
    }

    #[test]
    fn plan_text_comes_from_the_write_or_the_diff() {
        let host = linux("/home/me");
        let plan = "/home/me/.grok/sessions/s1/plan.md";
        assert_eq!(
            plan_markdown_from_tool_call(
                &data(
                    json!({"rawInput": {"file_path": plan, "content": "# From rawInput\n\n- a\n"}})
                ),
                &host
            )
            .as_deref(),
            Some("# From rawInput\n\n- a")
        );
        assert_eq!(
            plan_markdown_from_tool_call(&data(json!({"content": [{"type": "diff", "path": plan, "oldText": "", "newText": "# From diff\n"}]})), &host).as_deref(),
            Some("# From diff")
        );
        assert_eq!(
            plan_markdown_from_tool_call(
                &data(json!({"rawInput": {"file_path": plan, "content": ""},
                "content": [{"type": "diff", "path": plan, "newText": "# After empty\n"}]})),
                &host
            )
            .as_deref(),
            Some("# After empty")
        );
        assert_eq!(
            plan_markdown_from_tool_call(
                &data(json!({"rawInput": {"file_path": plan, "content": ""}})),
                &host
            )
            .as_deref(),
            Some("")
        );
        assert_eq!(
            plan_markdown_from_tool_call(
                &data(json!({"rawInput": {"file_path": "/repo/docs/plan.md", "content": "# P"}})),
                &host
            ),
            None
        );
    }
}
