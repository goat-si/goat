//! Session environments for registry agents, from v1 `sessionEnvironmentKey.ts` (7-22) at
//! 916b5ccc1b2. v1's `environmentCheck.ts` and the key/origin helpers of
//! `sessionEnvironmentKey.ts` (24-51) have no GOAT 2 caller and are not carried (round 7 part 6b.7).

use super::command_path::Environment;
use super::settings::{RegistrySettings, Source};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
