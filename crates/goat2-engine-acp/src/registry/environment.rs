//! Session environments for registry agents, from v1 `environmentCheck.ts` (all 24 lines) and
//! `sessionEnvironmentKey.ts` (all 51 lines) at 916b5ccc1b2.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::future::Future;

use super::command_path::Environment;
use super::settings::{RegistrySettings, Source};

/// v1 `environmentCheck.ts:3-5`: one comparable string for an environment. Keys are sorted by
/// code point (v1 uses `localeCompare`; only equality of the text is ever used).
pub fn environment_text(environment: &Environment) -> String {
    serde_json::to_string(&environment.iter().collect::<Vec<_>>()).unwrap_or_default()
}

/// v1 `environmentCheck.ts:7-24`: rerun `attempt` while the environment it captured is no longer
/// `current` when it finishes, three runs at most; the last result stands.
pub async fn until_environment_holds<A, E, C, CF, T, TF>(
    mut current: C,
    mut attempt: T,
) -> Result<A, E>
where
    C: FnMut() -> CF,
    CF: Future<Output = Environment>,
    T: FnMut() -> TF,
    TF: Future<Output = Result<(Environment, A), E>>,
{
    let mut runs = 1;
    loop {
        let (environment, result) = attempt().await?;
        if runs == 3 || environment_text(&current().await) == environment_text(&environment) {
            return Ok(result);
        }
        runs += 1;
    }
}

/// v1 `sessionEnvironmentKey.ts:7-10`.
fn is_claude_acp_agent(settings: &RegistrySettings) -> bool {
    match settings.source {
        Source::Registry => settings.agent_id == "claude-acp",
        Source::Local => {
            let name = settings
                .command_path
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("");
            regex::Regex::new(r"(?i)^claude-agent-acp(\.exe|\.cmd)?$")
                .expect("static regex")
                .is_match(name)
        }
    }
}

/// v1 `sessionEnvironmentKey.ts:12-22`: the environment a session of these settings launches
/// with (claude-acp gets `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1` unless already set).
pub fn session_environment(settings: &RegistrySettings, environment: &Environment) -> Environment {
    let mut env = environment.clone();
    if is_claude_acp_agent(settings) {
        env.entry("CLAUDE_AGENT_ACP_EXPERIMENTAL_V2".into())
            .or_insert_with(|| "1".into());
    }
    env
}

/// v1 `sessionEnvironmentKey.ts:24-32`: names one environment without holding its values.
pub fn environment_key(environment: &Environment) -> String {
    let text = serde_json::to_string(&environment.iter().collect::<Vec<_>>()).unwrap_or_default();
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// v1 `sessionEnvironmentKey.ts:34-51`: session config options tagged with the environment they
/// came from. v1 keeps the tag in a `WeakMap` keyed by the array; GOAT 2 carries it alongside.
#[derive(Debug, Clone, PartialEq)]
pub struct TaggedConfigOptions {
    pub options: Vec<Value>,
    origin: String,
}

pub fn with_configuration_origin(options: &[Value], environment_key: &str) -> TaggedConfigOptions {
    TaggedConfigOptions {
        options: options.to_vec(),
        origin: environment_key.to_owned(),
    }
}

pub fn configuration_origin(options: &TaggedConfigOptions) -> Option<&str> {
    Some(options.origin.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn env(pairs: &[(&str, &str)]) -> Environment {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn claude_acp_gets_the_v2_flag_once() {
        let registry = RegistrySettings {
            agent_id: "claude-acp".into(),
            ..Default::default()
        };
        assert_eq!(
            session_environment(&registry, &env(&[]))["CLAUDE_AGENT_ACP_EXPERIMENTAL_V2"],
            "1"
        );
        let kept = env(&[("CLAUDE_AGENT_ACP_EXPERIMENTAL_V2", "0")]);
        assert_eq!(session_environment(&registry, &kept), kept);
        let local = RegistrySettings {
            source: Source::Local,
            command_path: "C:\\tools\\Claude-Agent-ACP.CMD".into(),
            ..Default::default()
        };
        assert!(
            session_environment(&local, &env(&[])).contains_key("CLAUDE_AGENT_ACP_EXPERIMENTAL_V2")
        );
        let other = RegistrySettings {
            agent_id: "devin".into(),
            ..Default::default()
        };
        assert!(session_environment(&other, &env(&[])).is_empty());
    }

    #[test]
    fn key_matches_v1_json_and_sha256() {
        // sha256 of [["A","1"],["B","2"]], the JSON v1 hashes.
        let key = environment_key(&env(&[("B", "2"), ("A", "1")]));
        let expected: String = Sha256::digest(br#"[["A","1"],["B","2"]]"#)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(key, expected);
        assert_eq!(environment_text(&env(&[("A", "1")])), r#"[["A","1"]]"#);
        let tagged = with_configuration_origin(&[Value::Null], &key);
        assert_eq!(configuration_origin(&tagged), Some(key.as_str()));
    }

    #[tokio::test]
    async fn reruns_until_the_environment_holds_at_most_three_times() {
        let attempts = Cell::new(0);
        let current = Cell::new(0);
        let result: Result<u32, ()> = until_environment_holds(
            || {
                let n = current.get();
                current.set(n + 1);
                async move { env(&[("N", if n == 0 { "changed" } else { "same" })]) }
            },
            || {
                attempts.set(attempts.get() + 1);
                let n = attempts.get();
                async move { Ok((env(&[("N", "same")]), n)) }
            },
        )
        .await;
        assert_eq!(result, Ok(2));
        let runs = Cell::new(0);
        let last: Result<u32, ()> = until_environment_holds(
            || async { env(&[("N", "never")]) },
            || {
                runs.set(runs.get() + 1);
                let n = runs.get();
                async move { Ok((env(&[]), n)) }
            },
        )
        .await;
        assert_eq!(last, Ok(3));
    }
}
