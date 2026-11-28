//! The single seam onto `goat2-contracts`: every contract type the driver uses is re-exported here,
//! so a contract change touches this file only.

pub use goat2_contracts::{
    ApprovalDecision, ApprovalOption, CommandAction, DeliveredAs, DeliveryOutcome, EngineDriver,
    EngineItemLocator, EngineRef, EngineTurnRef, InputDelivered, InputId, ItemCompleted, ItemId,
    MessageId, NativeItemRef, NativeRefStrength, PlanId, PlanStep, ProviderCapabilities,
    ProviderFailure, RequestId, RequestKind, RequestOpened, RequestOutcome, RequestResolved, RunAccepted,
    RunFinished, RunId, RunOutcome, ThreadId, TurnItem, TurnItemBody,
};
