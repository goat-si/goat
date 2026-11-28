//! Per-agent handling of ACP registry agents, lifted from GOAT v1
//! `packages/provider-acp-registry/src/server/*Acp.ts@916b5ccc1b2` and the agent detection of
//! `adapter.ts:213-267`.

pub mod claude;
pub mod copilot;
pub mod devin;
pub mod droid;
mod forms;
pub mod kimi;
pub mod omp;
pub mod opencode;
pub mod vibe;

pub use devin::{devin_answerable_permission_options, normalize_devin_session_update};

use std::sync::OnceLock;

use regex::Regex;

/// Which registry agent a flavor drives (v1 `adapter.ts:213-267`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    Generic,
    /// Antigravity's `agy` as a local command (post-settle wakes; see the provenance notes).
    AntigravityCli,
    Omp,
    OpenCode,
    Devin,
    Copilot,
    Kimi,
    Claude,
    Droid,
    Glm,
    Vibe,
}

/// The executable name of a command path (v1 `commandPath.split(/[\\/]/).pop()`).
pub fn executable_name(program: &str) -> &str {
    program.rsplit(['/', '\\']).next().unwrap_or_default()
}

fn regex(cell: &'static OnceLock<Regex>, source: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(source).expect("regex"))
}

/// v1 `adapter.ts:213-267`. Local commands have no registry id; their executable names them.
pub fn agent_kind(agent_id: &str, program: &str, local: bool) -> AgentKind {
    static AGY: OnceLock<Regex> = OnceLock::new();
    static OMP: OnceLock<Regex> = OnceLock::new();
    static OPENCODE: OnceLock<Regex> = OnceLock::new();
    static DEVIN: OnceLock<Regex> = OnceLock::new();
    static COPILOT: OnceLock<Regex> = OnceLock::new();
    static KIMI: OnceLock<Regex> = OnceLock::new();
    static CLAUDE: OnceLock<Regex> = OnceLock::new();
    static DROID: OnceLock<Regex> = OnceLock::new();
    static GLM: OnceLock<Regex> = OnceLock::new();
    static VIBE: OnceLock<Regex> = OnceLock::new();
    let registry = if local { "" } else { agent_id };
    let name = executable_name(program);
    let local_is = |cell, source| local && regex(cell, source).is_match(name);
    if local_is(&AGY, r"(?i)^agy(\.exe|\.cmd)?$") {
        AgentKind::AntigravityCli
    } else if local_is(&OMP, r"(?i)^omp(\.exe|\.cmd)?$") {
        AgentKind::Omp
    } else if matches!(registry, "opencode" | "opencode-v2")
        || local_is(&OPENCODE, r"(?i)^opencode(?:-v2)?(\.exe|\.cmd)?$")
    {
        AgentKind::OpenCode
    } else if registry == "devin" || local_is(&DEVIN, r"(?i)^devin(\.exe)?$") {
        // Cloud auto setup adds Devin as a local `devin acp` command, so match the binary too.
        AgentKind::Devin
    } else if registry == "github-copilot-cli" || local_is(&COPILOT, r"(?i)^copilot(\.exe|\.cmd)?$")
    {
        AgentKind::Copilot
    } else if registry == "kimi-code" || local_is(&KIMI, r"(?i)^kimi(\.exe|\.cmd)?$") {
        AgentKind::Kimi
    } else if registry == "claude-acp" || local_is(&CLAUDE, r"(?i)^claude-agent-acp(\.exe|\.cmd)?$")
    {
        AgentKind::Claude
    } else if registry == "factory-droid"
        || local_is(&DROID, r"(?i)^(?:factory-)?droid(\.exe|\.cmd)?$")
    {
        AgentKind::Droid
    } else if registry == "glm-acp-agent"
        || local_is(&GLM, r"(?i)^glm(?:-acp-agent)?(\.exe|\.cmd)?$")
    {
        AgentKind::Glm
    } else if registry == "mistral-vibe"
        || local_is(&VIBE, r"(?i)^(?:mistral-)?vibe(?:-acp)?(\.exe|\.cmd)?$")
    {
        AgentKind::Vibe
    } else {
        AgentKind::Generic
    }
}

/// v1 `mcpTransport.ts:5-27`: Command Code takes GOAT's MCP endpoint over ACP HTTP; it cannot
/// start the stdio bridge on Windows, where cmd.exe splits the unquoted GOAT path at the space.
pub fn prefers_http_mcp_transport(local: bool, program: &str, args: &[String]) -> bool {
    static EXECUTABLES: OnceLock<Regex> = OnceLock::new();
    static ENTRY_POINTS: OnceLock<[Regex; 2]> = OnceLock::new();
    if !local {
        return false;
    }
    let entry_points = ENTRY_POINTS.get_or_init(|| {
        [
            Regex::new(r"(?i)(?:^|[\\/])node_modules[\\/]command-code[\\/]").expect("regex"),
            Regex::new(r"(?i)(?:^|[\\/])command-code[\\/]dist[\\/](?:index|cli)\.mjs$")
                .expect("regex"),
        ]
    });
    regex(
        &EXECUTABLES,
        r"(?i)^(?:cmdc|command-code|commandcode)(?:\.exe)?$",
    )
    .is_match(executable_name(program))
        || args
            .iter()
            .any(|arg| entry_points.iter().any(|p| p.is_match(arg)))
}

/// v1 `settings.ts:13-25`: the MiniMax Code preset launch (`mcode acp`), for its quota display.
pub fn is_minimax_code(local: bool, program: &str, args: &[String]) -> bool {
    local && program.trim().rsplit('/').next() == Some("mcode") && args == ["acp"]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_are_recognized_by_registry_id_or_local_executable() {
        assert_eq!(agent_kind("devin", "x", false), AgentKind::Devin);
        assert_eq!(agent_kind("devin", "x", true), AgentKind::Generic);
        assert_eq!(agent_kind("", r"C:\bin\DEVIN.EXE", true), AgentKind::Devin);
        assert_eq!(agent_kind("", "devin.cmd", true), AgentKind::Generic);
        assert_eq!(agent_kind("", "/bin/COPILOT.cmd", true), AgentKind::Copilot);
        assert_eq!(agent_kind("opencode-v2", "x", false), AgentKind::OpenCode);
        assert_eq!(agent_kind("", "/u/opencode-v2", true), AgentKind::OpenCode);
        assert_eq!(agent_kind("", "/u/omp", true), AgentKind::Omp);
        assert_eq!(agent_kind("omp", "x", false), AgentKind::Generic);
        assert_eq!(agent_kind("kimi-code", "x", false), AgentKind::Kimi);
        assert_eq!(agent_kind("", "kimi.exe", true), AgentKind::Kimi);
        assert_eq!(agent_kind("claude-acp", "x", false), AgentKind::Claude);
        assert_eq!(
            agent_kind("", "/n/claude-agent-acp", true),
            AgentKind::Claude
        );
        assert_eq!(agent_kind("", "factory-droid", true), AgentKind::Droid);
        assert_eq!(agent_kind("factory-droid", "x", false), AgentKind::Droid);
        assert_eq!(agent_kind("", "glm-acp-agent", true), AgentKind::Glm);
        assert_eq!(agent_kind("", "mistral-vibe-acp", true), AgentKind::Vibe);
        assert_eq!(agent_kind("", "agy", true), AgentKind::AntigravityCli);
        assert_eq!(
            agent_kind("deepseek", "deepseek", false),
            AgentKind::Generic
        );
    }

    #[test]
    fn command_code_prefers_http_and_minimax_preset() {
        assert!(prefers_http_mcp_transport(true, "/bin/cmdc", &[]));
        assert!(prefers_http_mcp_transport(
            true,
            "node",
            &["/x/node_modules/command-code/dist/cli.mjs".into()]
        ));
        assert!(!prefers_http_mcp_transport(false, "/bin/cmdc", &[]));
        assert!(!prefers_http_mcp_transport(true, "/bin/other", &[]));
        assert!(is_minimax_code(
            true,
            "/usr/local/bin/mcode",
            &["acp".into()]
        ));
        assert!(!is_minimax_code(
            true,
            "mcode",
            &["acp".into(), "--x".into()]
        ));
    }
}
