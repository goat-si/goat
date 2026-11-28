// Wire types for the host WebSocket API. Everything comes from @goat2/contracts-rs (generated from
// crates/goat2-contracts, structure/30_wire.md); this file only narrows the unions for local use.
export type {
  BotFace, BotProfile, CardCursor, ChatAttachment, ClientFrame, CommandError, CommandValue, DecisionOption,
  EngineChoice, Fold, HostFrame, InputId, InputMode, ItemId, LogLine, QueuedInput, RequestId, RequestKind,
  RequestOpened, RequestOutcome, RunOutcome, ThreadCard, ThreadCursor, ThreadId, ThreadStatus, TurnItem,
} from "@goat2/contracts-rs";
import type { ClientFrame, HostFrame, LogLine } from "@goat2/contracts-rs";

export type FrameOf<U, T extends string> = Extract<U, { type: T }>;
export type CommandFrame = Exclude<
  ClientFrame,
  { type: "subscribe_cards" | "subscribe_thread" | "unsubscribe" | "read_page" | "resync_item" | "pong" }
>;
export type CommandType = CommandFrame["type"];
/** A command without the correlation ids; the client adds reqId and clientRequestId. */
export type CommandBody<T extends CommandType = CommandType> = T extends CommandType
  ? Omit<FrameOf<CommandFrame, T>, "reqId" | "clientRequestId">
  : never;
export type CommandResult = FrameOf<HostFrame, "command_result">;
export type LogType = LogLine["type"];
export type LineOf<T extends LogType> = Extract<LogLine, { type: T }>;
