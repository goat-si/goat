//! Grok skills for the `$name` prompt rewrite.
//!
//! Ported from v1 `packages/provider-grok/src/server/skills.ts:1-146` (`leadingGrokSkillMention`,
//! `decodeGrokInspectSkills`, `discoverGrokSkills`), `probeEnvironment.ts:1-5`
//! (`grokProbeEnvironment`), `packages/provider-core/src/server/probeEnvironment.ts:2-13`
//! (`providerProbeEnvironment`), `snapshotProbe.ts:50-61` (`resolveProviderProbeTimeoutMs`) and the
//! `rewriteUserText` hook in `adapter.ts:365-383`: Grok expands only a leading `/name`, while the
//! composer inserts `$name`, so a leading `$name` naming an enabled skill becomes `/name`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use crate::flavor::PromptContext;
use crate::process::Launch;

/// v1 `GROK_SKILLS_PROBE_TIMEOUT_MS`.
const GROK_SKILLS_PROBE_TIMEOUT_MS: u64 = 4_000;

/// JavaScript `\s` (Rust `char::is_whitespace` plus U+FEFF).
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

static CURRENCY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{Sc}$").expect("regex"));
static MONEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?$").expect("regex"));

/// v1 `leadingGrokSkillMention` with the composer's `SKILL_MENTION_PATTERN`
/// (`packages/shared/src/composerInlineTokens.ts:26-30`) anchored to the message start: optional
/// whitespace, a currency sign, then a name of `[a-zA-Z0-9][a-zA-Z0-9:_-]*` with a letter in it,
/// ending at whitespace or the end. Amounts such as `$25` or `$3k` are not names.
pub fn leading_skill_mention(text: &str) -> Option<(String, String)> {
    let start = text.len() - text.trim_start_matches(js_space).len();
    let rest = &text[start..];
    let sign = rest.chars().next()?;
    if !CURRENCY.is_match(&sign.to_string()) {
        return None;
    }
    let after = &rest[sign.len_utf8()..];
    let name_len = after
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-')))
        .unwrap_or(after.len());
    let name = &after[..name_len];
    let tail = &after[name_len..];
    if name.is_empty()
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name.bytes().any(|b| b.is_ascii_alphabetic())
        || MONEY.is_match(name)
        || !tail.chars().next().is_none_or(js_space)
    {
        return None;
    }
    Some((name.to_owned(), tail.to_owned()))
}

/// One skill from `grok inspect --json` (v1 `ServerProviderSkill`, the fields the rewrite reads).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrokSkill {
    pub name: String,
    pub path: String,
    pub enabled: bool,
}

/// v1 `decodeGrokInspectSkills` (skills.ts:46-88): skills with a name and a source path, the last
/// entry of a name winning, sorted by name.
pub fn decode_inspect_skills(stdout: &str) -> Option<Vec<GrokSkill>> {
    let parsed: Value = serde_json::from_str(stdout).ok()?;
    let entries = parsed.as_object()?.get("skills")?.as_array()?;
    let mut by_name = BTreeMap::new();
    for entry in entries.iter().filter_map(Value::as_object) {
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let path = entry
            .get("source")
            .and_then(Value::as_object)
            .and_then(|s| s.get("path"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if name.is_empty() || path.is_empty() {
            continue;
        }
        by_name.insert(
            name.to_owned(),
            GrokSkill {
                name: name.to_owned(),
                path: path.to_owned(),
                enabled: entry.get("userInvocable") != Some(&Value::Bool(false)),
            },
        );
    }
    Some(by_name.into_values().collect())
}

fn lookup(launch_env: &[(String, String)], name: &str) -> Option<String> {
    launch_env
        .iter()
        .rev()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var(name).ok())
}

/// v1 `resolveProviderProbeTimeoutMs("grok", 4000, env)`: an override only extends the default.
fn probe_timeout(launch_env: &[(String, String)]) -> Duration {
    let ms = lookup(launch_env, "GOAT_GROK_PROBE_TIMEOUT_MS")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| *ms > GROK_SKILLS_PROBE_TIMEOUT_MS && *ms <= 2_147_483_647)
        .unwrap_or(GROK_SKILLS_PROBE_TIMEOUT_MS);
    Duration::from_millis(ms)
}

/// v1 `discoverGrokSkills` (skills.ts:90-146): run `<grok> inspect --json` in the session's
/// working directory with the session environment plus v1's probe variables. None on spawn
/// failure, timeout, non-zero exit, output past v1's 8 MiB probe cap (skills.ts:97-109 collects
/// through `spawnAndCollect`, snapshotProbe.ts:159,182-205; the process is killed and reaped at
/// the cap, final review 6 finding B1) or undecodable output.
pub async fn discover_skills(program: &Path, context: &PromptContext) -> Option<Vec<GrokSkill>> {
    let identity = Launch::new(program).without_host_identity();
    // Resolved against the child's PATH (the session's, else the host's) so std keeps
    // posix_spawn (crate::process module docs). Not found: no skills, as a spawn failure.
    let child_path = context
        .launch_env
        .iter()
        .rev()
        .find(|(name, _)| name == "PATH")
        .map(|(_, value)| std::ffi::OsString::from(value))
        .or_else(|| std::env::var_os("PATH"));
    let cwd = (!context.cwd.is_empty()).then(|| std::path::Path::new(&context.cwd));
    let resolved = crate::process::resolve_program(program, child_path.as_deref(), cwd).ok()?;
    let mut command = tokio::process::Command::new(resolved);
    command
        .args(["inspect", "--json"])
        .stdin(std::process::Stdio::null());
    if !context.cwd.is_empty() {
        command.current_dir(&context.cwd);
    }
    for (name, _) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if identity.env_remove.contains(&name)
            || identity
                .env_remove_prefixes
                .iter()
                .any(|prefix| text.starts_with(prefix.as_str()))
        {
            command.env_remove(&name);
        }
    }
    for (name, value) in &context.launch_env {
        command.env(name, value);
    }
    // v1 providerProbeEnvironment + grokProbeEnvironment.
    for (name, value) in [
        ("MISE_OFFLINE", "1"),
        ("MISE_AUTO_INSTALL", "0"),
        ("MISE_NOT_FOUND_AUTO_INSTALL", "0"),
        ("npm_config_offline", "true"),
        ("NPM_CONFIG_OFFLINE", "true"),
        ("UV_OFFLINE", "1"),
        ("COREPACK_ENABLE_NETWORK", "0"),
        ("GROK_DISABLE_AUTOUPDATER", "1"),
    ] {
        command.env(name, value);
    }
    let output = tokio::time::timeout(
        probe_timeout(&context.launch_env),
        crate::probe::support::collect_command(command),
    )
    .await
    .ok()?
    .ok()?;
    if output.code != 0 {
        return None;
    }
    decode_inspect_skills(&output.stdout)
}

/// v1 grok `rewriteUserText` (adapter.ts:367-383).
pub async fn rewrite_skill_mention(text: String, context: PromptContext) -> String {
    let Some((name, rest)) = leading_skill_mention(&text) else {
        return text;
    };
    match discover_skills(&context.program, &context).await {
        Some(skills) if skills.iter().any(|s| s.enabled && s.name == name) => {
            format!("/{name}{rest}")
        }
        _ => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_are_leading_names_not_amounts() {
        assert_eq!(
            leading_skill_mention("$deploy ship it"),
            Some(("deploy".into(), " ship it".into()))
        );
        assert_eq!(
            leading_skill_mention("  $review"),
            Some(("review".into(), String::new()))
        );
        assert_eq!(
            leading_skill_mention("€plan:fast now"),
            Some(("plan:fast".into(), " now".into()))
        );
        assert_eq!(leading_skill_mention("$25 please"), None);
        assert_eq!(leading_skill_mention("$3k"), None);
        assert_eq!(leading_skill_mention("$1e5 x"), None);
        assert_eq!(
            leading_skill_mention("$1e x"),
            Some(("1e".into(), " x".into()))
        );
        assert_eq!(leading_skill_mention("$deploy.now"), None);
        assert_eq!(leading_skill_mention("run $deploy"), None);
        assert_eq!(leading_skill_mention("$-x"), None);
    }

    #[test]
    fn inspect_output_keeps_named_skills_with_paths() {
        let skills = decode_inspect_skills(
            r#"{"skills": [
            {"name": "zeta", "source": {"path": "/s/z", "type": "user"}},
            {"name": "alpha", "source": {"path": "/s/a"}, "userInvocable": false},
            {"name": "", "source": {"path": "/s/x"}},
            {"name": "nopath"}
        ]}"#,
        )
        .unwrap();
        assert_eq!(
            skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["alpha", "zeta"]
        );
        assert!(!skills[0].enabled && skills[1].enabled);
        assert_eq!(decode_inspect_skills("not json"), None);
    }

    #[cfg(unix)]
    fn fake_grok(dir: &Path, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("grok");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn context(dir: &Path, program: &Path, env: &[(&str, &str)]) -> PromptContext {
        PromptContext {
            cwd: dir.to_string_lossy().into_owned(),
            program: program.to_path_buf(),
            launch_env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    /// Final review 6 finding B1 (v1 skills.ts:97-109 collects through `spawnAndCollect`, which
    /// fails past 8 MiB of stdout, snapshotProbe.ts:159,182-205): valid skills JSON followed by
    /// more than the cap of padding is refused, never collected whole.
    #[cfg(unix)]
    #[tokio::test]
    async fn oversized_inspect_output_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let pad = crate::probe::support::MAX_PROBE_OUTPUT_BYTES + 1024;
        let program = fake_grok(
            dir.path(),
            &format!(
                "printf '%s' '{{\"skills\":[{{\"name\":\"deploy\",\"source\":{{\"path\":\"/s\"}}}}]}}'\nhead -c {pad} /dev/zero | tr '\\0' ' '"
            ),
        );
        let context = context(dir.path(), &program, &[]);
        assert_eq!(discover_skills(&program, &context).await, None);
    }

    /// B1: an inspect that never stops writing (and ignores SIGPIPE) is killed and reaped as soon
    /// as the cap is passed, well inside the (here extended) probe timeout.
    #[cfg(unix)]
    #[tokio::test]
    async fn endless_inspect_output_is_killed_and_reaped_at_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let program = fake_grok(
            dir.path(),
            &format!(
                "echo $$ > '{}'\ntrap '' PIPE\nchunk=$(head -c 65536 /dev/zero | tr '\\0' ' ')\nwhile :; do printf '%s' \"$chunk\"; done",
                pid_file.display()
            ),
        );
        let context = context(
            dir.path(),
            &program,
            &[("GOAT_GROK_PROBE_TIMEOUT_MS", "600000")],
        );
        let result =
            tokio::time::timeout(Duration::from_secs(60), discover_skills(&program, &context))
                .await
                .expect("the oversized inspect ends at the cap, not at the probe timeout");
        assert_eq!(result, None);
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: signal 0 only checks whether the (reaped) child still exists.
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        assert!(
            !alive,
            "the inspect process {pid} was left running or unreaped"
        );
    }
}
