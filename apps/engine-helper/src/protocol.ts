// Wire types for the engine-helper stdio protocol. See ../PROTOCOL.md.
import type {
  ChatAttachment,
  ItemId,
  ModelSelection,
  ProviderProbeResult,
  RequestOutcome,
  RuntimeMode,
  TurnItem,
} from "@goat2/contracts-rs";

export const PROTOCOL_VERSION = 1;

export const ENGINE_KINDS = ["cursor", "opencode", "muse", "fake"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

export type JsonObject = { [key: string]: unknown };

export interface McpEndpoint {
  readonly url: string;
  readonly bearerToken: string;
}

export interface LaunchSpec {
  readonly binary?: string | null;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

/** goat2-engine-api `Instructions`: text GOAT adds to the engine's own instructions. */
export interface Instructions {
  /** Appended to the engine's system prompt. */
  readonly appendSystemPrompt?: string | null;
  /** Put before the first user message of a new session, for engines without a system slot. */
  readonly firstMessagePreamble?: string | null;
}

export interface InitializeParams {
  readonly protocol: number;
  readonly engine: EngineKind;
  readonly threadId: string;
  readonly cwd: string;
  readonly resume: string | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly mcp: McpEndpoint | null;
  readonly instructions: Instructions | null;
  readonly launch: LaunchSpec | null;
}

/** `probe`: install, version, sign-in state and models without a session. */
export interface ProbeParams {
  readonly protocol: number;
  readonly engine: EngineKind;
  readonly cwd: string | null;
  readonly launch: LaunchSpec | null;
}

/** goat2-contracts `ProviderProbeResult` (v1 ServerProvider subset). */
export type ProbeResult = ProviderProbeResult;

export interface EngineInput {
  readonly inputId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface TurnSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export type TurnStartResult =
  | { readonly status: "accepted"; readonly turnId: string }
  | { readonly status: "declined" | "refused_unowned" | "unknown"; readonly reason: string };

export type SteerResult =
  | { readonly status: "accepted" }
  | { readonly status: "declined" | "refused_unowned" | "unknown"; readonly reason: string };

export interface RequestAnswer {
  readonly outcome: RequestOutcome;
  readonly text?: string | null;
  readonly answers?: JsonObject | null;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A TurnItem as the helper emits it; the Rust driver fills the omitted fields. */
export type HelperItem = DistributiveOmit<
  TurnItem,
  "threadId" | "runId" | "ordinal" | "providerThreadId"
>;

export type TurnOutcome =
  | { readonly type: "done" }
  | { readonly type: "failed"; readonly reason: string }
  | { readonly type: "interrupted" };

export type RequestKind = "approval" | "question" | "signin";

export type EngineEvent =
  | { readonly type: "text_delta"; readonly turnId: string; readonly itemId: ItemId; readonly text: string }
  | {
      readonly type: "item_completed";
      readonly turnId: string;
      readonly item: HelperItem;
      readonly locator: { readonly turnId: string; readonly itemId: string } | null;
    }
  | {
      readonly type: "request_opened";
      readonly turnId: string;
      readonly key: string;
      readonly itemId: ItemId | null;
      readonly kind: RequestKind;
      readonly summary: string;
      readonly item: HelperItem | null;
    }
  | { readonly type: "request_closed"; readonly key: string }
  | {
      readonly type: "auth_required";
      readonly turnId: string | null;
      readonly url: string | null;
      readonly message: string;
    }
  | {
      readonly type: "subagent_update";
      readonly turnId: string | null;
      readonly subagentId: string;
      readonly status: HelperItem["status"];
      readonly title: string | null;
      readonly progress: string | null;
    }
  | { readonly type: "turn_finished"; readonly turnId: string; readonly outcome: TurnOutcome }
  | { readonly type: "exited"; readonly reason: string };

export type ErrorCode = "bad_request" | "unavailable" | "start_failed" | "transport";

export class HelperError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HelperError";
    this.code = code;
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";
