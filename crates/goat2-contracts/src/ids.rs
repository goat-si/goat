//! String identifiers. Each is a plain JSON string on the wire and `string` in TypeScript.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(
            Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS, JsonSchema,
        )]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

string_id!(
    /// A GOAT thread. Also the folder name under `~/.goat2/threads/`.
    ThreadId
);
string_id!(
    /// A run: one batch of inputs sent to the engine until the answer ends.
    RunId
);
string_id!(
    /// A finished item inside a run (TurnItem id).
    ItemId
);
string_id!(
    /// An input accepted into a thread's mailbox.
    InputId
);
string_id!(
    /// A bot. Each bot owns one `bot` thread.
    BotId
);
string_id!(
    /// A project the thread belongs to (card index column).
    ProjectId
);
string_id!(
    /// A configured provider instance (v1 `ProviderInstanceId`), e.g. `codex`.
    ProviderInstanceId
);
string_id!(
    /// A human-in-the-loop request (approval, question, sign-in).
    RequestId
);
string_id!(
    /// Generation of a `goat.jsonl` file or of the card index. A UUID string.
    Epoch
);
string_id!(
    /// A chat message id carried by user and assistant TurnItems.
    MessageId
);
string_id!(
    /// A plan id carried by plan and todo TurnItems.
    PlanId
);
