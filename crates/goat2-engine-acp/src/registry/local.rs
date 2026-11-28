//! Local resolution and MCP transport, ported from GOAT v1 at 916b5ccc1b2.
//! `AcpRegistrySupport.ts:1557-1567,1715-1750`, `mcpTransport.ts:3-26`.

use super::command_path::{self, Environment};
use super::index::{RegistrySettings, Source};
use crate::flavor::LaunchCommand;

/// v1 `mcpTransport.ts:16-26`.
pub fn prefers_http_mcp(settings: &RegistrySettings) -> bool {
    if !matches!(settings.source, Source::Local) {
        return false;
    }
    let name = settings
        .command_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let pattern = regex::Regex::new(r"(?i)^(?:cmdc|command-code|commandcode)(?:\.exe)?$")
        .expect("static regex");
    let entry = regex::Regex::new(
        r"(?i)(?:^|[\\/])(?:node_modules[\\/]command-code[\\/]|command-code[\\/]dist[\\/](?:index|cli)\.mjs$)",
    )
    .expect("static regex");
    pattern.is_match(name) || settings.command_args.iter().any(|a| entry.is_match(a))
}

/// v1 `AcpRegistrySupport.ts:1719-1750`: resolve a local executable against the
/// supplied PATH. The caller provides the environment to avoid global mutations.
/// [super::catalog::AcpRegistryCatalog::resolve] is the full path with v1's error reasons.
pub fn resolve_local(
    settings: &RegistrySettings,
    path: &std::ffi::OsStr,
) -> Result<LaunchCommand, &'static str> {
    let command = settings.command_path.trim();
    if command.is_empty() {
        return Err("Local ACP provider requires an executable.");
    }
    let platform = command_path::host_platform();
    let env: Environment = [("PATH".to_owned(), path.to_string_lossy().into_owned())].into();
    let found = command_path::resolve_executable(command, platform, &env)
        .ok_or("Local ACP executable is not available on this environment's PATH.")?;
    if platform == "win32"
        && found
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("cmd") || s.eq_ignore_ascii_case("bat"))
    {
        return Err(
            "Local ACP commands launch without a shell. For a Windows batch wrapper, configure the underlying executable (for example node.exe) and pass the script path as an argument.",
        );
    }
    Ok(LaunchCommand::new(
        command_path::resolve_absolute_local_command(&found),
        settings.command_args.clone(),
    ))
}

/// Resolve an explicit registry executable override, retaining registry arguments and environment.
/// v1 `AcpRegistrySupport.ts:1752-1776,1839-1857`.
pub fn resolve_override(
    settings: &RegistrySettings,
    agent: &super::index::Agent,
    target: Option<&str>,
    path: &std::ffi::OsStr,
) -> Result<LaunchCommand, String> {
    let distribution = super::index::resolve_distribution(agent, &settings.distribution, target)
        .ok_or_else(|| format!("No compatible ACP Registry distribution for {}.", agent.id))?;
    let mut local_settings = settings.clone();
    local_settings.command_args = distribution.args;
    let mut command = resolve_local(&local_settings, path).map_err(|_| {
        format!(
            "ACP Registry agent {} requires '{}', but it is not available on this provider instance's PATH.",
            agent.id,
            settings.command_path.trim()
        )
    })?;
    command.env = distribution.env.into_iter().collect();
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_matches_executable_or_entry_point_only_for_local() {
        let mut s = RegistrySettings {
            source: Source::Local,
            command_path: "C:\\Program Files\\CMDC.exe".into(),
            ..Default::default()
        };
        assert!(prefers_http_mcp(&s));
        s.command_path = "node".into();
        s.command_args = vec!["/work/node_modules/command-code/dist/cli.mjs".into()];
        assert!(prefers_http_mcp(&s));
        s.source = Source::Registry;
        assert!(!prefers_http_mcp(&s));
    }
    #[cfg(unix)]
    #[test]
    fn local_resolution_uses_given_path_and_args() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("agent");
        std::fs::write(&binary, b"test").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let s = RegistrySettings {
            source: Source::Local,
            command_path: "agent".into(),
            command_args: vec!["acp".into()],
            ..Default::default()
        };
        let result = resolve_local(&s, dir.path().as_os_str()).unwrap();
        assert_eq!(result.program, binary);
        assert_eq!(result.args, ["acp"]);
        assert!(resolve_local(&s, std::ffi::OsStr::new("/nonexistent")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn registry_override_preserves_distribution_arguments_and_environment() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("agent");
        std::fs::write(&binary, b"test").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let index = super::super::index::decode(br#"{"version":"1","agents":[{"id":"a","name":"A","version":"1","description":"","distribution":{"npx":{"package":"a@1.0.0","args":["acp"],"env":{"A":"B"}}}}]}"#).unwrap();
        let settings = RegistrySettings {
            command_path: "agent".into(),
            command_args: vec!["ignored".into()],
            ..Default::default()
        };
        let result =
            resolve_override(&settings, &index.agents[0], None, dir.path().as_os_str()).unwrap();
        assert_eq!(result.program, binary);
        assert_eq!(result.args, ["acp"]);
        assert_eq!(result.env, [("A".into(), "B".into())]);
    }
}
