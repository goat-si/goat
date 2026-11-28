//! Per-thread folder store for GOAT 2 (Part 1, lane A).
//!
//! `<dataDir>/threads/<threadId>/goat.jsonl` is the only source of truth: a header line
//! `{"v":1,"epoch":"<uuid>"}` followed by one [contract::LogLine] per line with a per-thread `seq`.
//! `card.json` (`{"v":1,"card","fold"}`) and `cards.sqlite` are caches that can be rebuilt from the
//! folders. There is no call that reads every thread body: startup reads the card index and only
//! opens the logs of threads whose index row is marked dirty or has an active run.
//!
//! See `DESIGN.md` in this crate for the write protocol, startup steps and the cursor contract.

mod blob;
pub mod contract;
mod error;
pub mod fold;
mod fsutil;
mod index;
mod line;
mod log;
mod store;

pub use error::{Result, StoreError};
pub use store::{
    Appended, CardFilter, CardUpdate, CardsRead, Faults, IndexOutcome, Page, Problem, Repaired,
    Settled, Snapshot, StartupReport, StartupTimings, Store, StoreOptions, ThreadRead,
    ThreadUpdate,
};

#[doc(hidden)]
pub use store::testing;
