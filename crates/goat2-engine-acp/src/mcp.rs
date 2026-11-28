//! GOAT's MCP server as an ACP agent receives it, decided as v1 does.
//!
//! v1 `packages/provider-acp/src/server/AcpSessionRuntime.ts:1475-1494` (`sessionMcpServers`) with the
//! lists from `mcpContext.ts:39-75`:
//! 1. HTTP, only when the agent advertises `mcpCapabilities.http` **and** the flavor prefers HTTP
//!    (v1 passes `httpMcpServers` only for `preferHttpMcp`, registry `mcpTransport.ts:16-27`).
//!    Agents that advertise HTTP still routinely drop injected HTTP servers (v1 comment,
//!    `mcpContext.ts:39-44`), so HTTP is never the default.
//! 2. MCP-over-ACP when the agent advertises `mcpCapabilities.acp` (v1 `mcpOverAcpBridge.ts`, served
//!    by [crate::mcp_over_acp]).
//! 3. Otherwise the stdio bridge (`goat2-acp-mcp-bridge`, v1 `goat acp-mcp-bridge`), which relays
//!    JSON-RPC to the same authenticated endpoint. The credential travels in the server's
//!    environment, never on its command line (v1 `cli/acpMcpBridge.ts:8`).
//!
//! An agent never starts without GOAT tools: when GOAT has an endpoint and the bridge cannot be
//! found, session setup fails.

use std::path::{Path, PathBuf};

use agent_client_protocol::v1::schema::{
    EnvVariable, HttpHeader, McpServer, McpServerAcp, McpServerHttp, McpServerStdio,
};
use goat2_engine_api::{EngineError, SessionSpec};

use crate::flavor::AcpFlavor;
use crate::wire::InitializeInfo;

/// v1 `AcpMcpStdioBridge.ts:571-572`: the bridge reads the endpoint and credential from these.
pub const BRIDGE_ENDPOINT_ENV: &str = "GOAT_ACP_MCP_ENDPOINT";
pub const BRIDGE_AUTHORIZATION_ENV: &str = "GOAT_ACP_MCP_AUTHORIZATION";
/// Overrides where the bridge binary is (development and tests).
pub const BRIDGE_PATH_ENV: &str = "GOAT2_ACP_MCP_BRIDGE";
/// The binary GOAT 2 ships next to `goat2-host`.
pub const BRIDGE_BINARY: &str = if cfg!(windows) {
    "goat2-acp-mcp-bridge.exe"
} else {
    "goat2-acp-mcp-bridge"
};
/// v1 `mcpContext.ts:50`: the server is named `goat` in every form.
pub const SERVER_NAME: &str = "goat";

/// The command an agent runs to reach GOAT's MCP endpoint over stdio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpBridgeCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl McpBridgeCommand {
    pub fn new(
        program: impl Into<PathBuf>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    /// `$GOAT2_ACP_MCP_BRIDGE`, else `goat2-acp-mcp-bridge` next to the running executable (where the
    /// app bundle puts it beside `goat2-host`). None when neither exists.
    pub fn locate() -> Option<Self> {
        if let Some(path) = std::env::var_os(BRIDGE_PATH_ENV).filter(|p| !p.is_empty()) {
            return Some(Self::new(PathBuf::from(path), Vec::<String>::new()));
        }
        let exe = std::env::current_exe().ok()?;
        Self::beside(&exe)
    }

    fn beside(exe: &Path) -> Option<Self> {
        let candidate = exe.parent()?.join(BRIDGE_BINARY);
        candidate
            .is_file()
            .then(|| Self::new(candidate, Vec::<String>::new()))
    }
}

/// The `Authorization` header value for GOAT's endpoint (v1 `authorizationHeader`).
pub fn authorization(spec: &SessionSpec) -> String {
    format!("Bearer {}", spec.mcp.bearer_token)
}

/// The `mcpServers` of `session/new`, `session/load` and `session/resume`.
pub fn mcp_servers_for(
    init: &InitializeInfo,
    spec: &SessionSpec,
    flavor: &dyn AcpFlavor,
    bridge: Option<&McpBridgeCommand>,
) -> Result<Vec<McpServer>, EngineError> {
    if spec.mcp.url.is_empty() {
        return Ok(Vec::new());
    }
    if init.mcp_http && flavor.prefers_http_mcp() {
        return Ok(vec![McpServer::Http(
            McpServerHttp::new(SERVER_NAME, spec.mcp.url.clone())
                .headers(vec![HttpHeader::new("Authorization", authorization(spec))]),
        )]);
    }
    if init.mcp_acp {
        return Ok(vec![McpServer::Acp(McpServerAcp::new(
            SERVER_NAME,
            SERVER_NAME,
        ))]);
    }
    let Some(bridge) = bridge else {
        return Err(EngineError::StartFailed(format!(
            "GOAT's MCP bridge ({BRIDGE_BINARY}) was not found next to the GOAT executable or at ${BRIDGE_PATH_ENV}; {} would start without GOAT tools",
            flavor.driver()
        )));
    };
    Ok(vec![McpServer::Stdio(
        McpServerStdio::new(SERVER_NAME, bridge.program.clone())
            .args(bridge.args.clone())
            .env(vec![
                EnvVariable::new(BRIDGE_ENDPOINT_ENV, spec.mcp.url.clone()),
                EnvVariable::new(BRIDGE_AUTHORIZATION_ENV, authorization(spec)),
            ]),
    )])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beside_finds_only_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("goat2-host");
        assert_eq!(McpBridgeCommand::beside(&exe), None);
        std::fs::write(dir.path().join(BRIDGE_BINARY), b"").unwrap();
        assert_eq!(
            McpBridgeCommand::beside(&exe),
            Some(McpBridgeCommand::new(
                dir.path().join(BRIDGE_BINARY),
                Vec::<String>::new()
            ))
        );
    }
}
