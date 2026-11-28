//! GOAT 2 Claude driver: drives the `claude` CLI over its stream-json control protocol and
//! implements `goat2-engine-api`. Behaviour is lifted from GOAT v1's `ClaudeAdapterV2`; see each
//! module's header for the v1 sources and `docs/PROVENANCE.md`.

pub mod auth;
pub mod capabilities;
pub mod engine;
pub mod items;
pub mod launch;
pub mod probe;
pub mod process;
pub mod protocol;
pub mod usage;
pub mod util;

pub use capabilities::claude_capabilities;
pub use engine::{AttachmentResolver, ClaudeEngineFactory, ClaudeEngineOptions, ClaudeSession};
pub use launch::{LaunchOptions, PermissionMode};
