//! GOAT 2 ACP driver: every ACP agent GOAT v1 supports (Grok, fx, Antigravity and the ACP
//! registry agents), on Zed's official `agent-client-protocol` crate, behind `goat2-engine-api`.

pub mod agents;
pub mod capabilities;
pub mod elicitation;
pub mod engine;
pub mod flavor;
pub mod items;
pub mod mcp;
pub mod normalize;
pub mod policy;
pub mod probe;
pub mod process;
pub mod registry;
pub mod wire;

pub use engine::{
    AcpEngineFactory, AcpSession, AcpTimeouts, AttachmentResolver, StartedAcp, prompt_id_of,
};
pub use flavor::{
    AcpFlavor, AuthPolicy, ClientCaps, FlavorEvent, LaunchCommand, ModelWrite, ResumeMethod,
    StdoutLine,
};
pub use mcp::McpBridgeCommand;
