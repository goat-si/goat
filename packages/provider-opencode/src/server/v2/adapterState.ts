import type { OpenCodeEvent } from "@opencode/client/effect";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  MessageId,
  ModelSelection,
  PlanId,
  RunId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { BackgroundWorkReport } from "@goat/provider-core/server/notification";
import type { makeProviderFailure } from "@goat/provider-core/server/failure";
import type * as OpenCode2Client from "./OpenCode2Client.ts";
import type { ModelRef } from "./modelRef.ts";
import type { Rule, RulesPolicy } from "./sessionRules.ts";

export type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { readonly type: T }>;
type Tokens = EventOf<"session.step.ended">["data"]["tokens"];

export interface TurnOwner {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: OrchestrationV2AppThread["id"];
  readonly runId: RunId | null;
  readonly runOrdinal: number;
  readonly rootNodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "cwd">;
}

export interface ActiveTurn {
  readonly input: TurnOwner;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly texts: Map<string, OpenBlock>;
  readonly tools: Map<string, { readonly name: string; input: Record<string, unknown> }>;
  readonly startedAt: Map<string, DateTime.Utc>;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  readonly usage: {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  // Steps OpenCode started; a step that ends without tokens leaves the total partial.
  startedSteps: number;
  // A reconnect dropped events, so steps may have ended unseen.
  missedEvents: boolean;
  steps: number;
  readonly models: Set<string>;
  lastStep: Tokens | undefined;
  before: string | null | undefined;
  compaction: { readonly nativeId: string; readonly startedAt: DateTime.Utc } | undefined;
  compactions: number;
  todoPlanId: PlanId | undefined;
  retry:
    | {
        readonly retry: OrchestrationV2ProviderRetry;
        readonly failure: OrchestrationV2ProviderFailure;
        readonly startedAt: DateTime.Utc;
      }
    | undefined;
  interrupted: boolean;
  unsent: boolean;
  readonly steers: Set<string>;
  readonly settledInbox: Set<string>;
  heldEnd: TurnTerminal | undefined;
  awaitingStart: boolean;
  /** Scope child tool IDs because model-generated IDs can repeat parent IDs. */
  readonly scope: string;
  usedSubagents: boolean;
}

export interface SubagentCall {
  readonly toolId: string;
  readonly nativeId: string;
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  prompt: string;
  title: string | null;
  agent: string | undefined;
  model: string | null;
  background: boolean;
  joined: SubagentCall | undefined;
  child: ThreadState | undefined;
  status: OrchestrationV2Subagent["status"];
  result: string | null;
  completedAt: DateTime.Utc | null;
}

export interface Wake {
  readonly messageId: MessageId | undefined;
  readonly events: Array<OpenCode2Client.OpenCode2StreamEvent>;
  running: boolean;
  readonly reports: Array<BackgroundWorkReport>;
  readonly detail: string | null;
  dropped: boolean;
  readonly after: string | undefined;
  readonly first: string | undefined;
  readonly children: Set<string>;
}

export interface OpenBlock {
  readonly block: { readonly assistantMessageID: string; readonly ordinal: number };
  readonly kind: "text" | "reasoning";
  readonly startedAt: DateTime.Utc;
  text: string;
}

export interface ImageJob {
  readonly turn: ActiveTurn;
  readonly toolId: string;
  readonly tool: { readonly name: string; input: Record<string, unknown> };
  previewed: boolean;
  readonly path: string;
  readonly model: string;
  status: "running" | "completed" | "error" | "cancelled";
}

// Settled jobs absorb replayed launches and late previews, so only the oldest are dropped.
const SETTLED_IMAGE_JOB_LIMIT = 64;

export const trackImageJob = (jobs: Map<string, ImageJob>, jobID: string, job: ImageJob) => {
  if (jobs.has(jobID)) return;
  jobs.set(jobID, job);
  let excess = -SETTLED_IMAGE_JOB_LIMIT;
  for (const each of jobs.values()) if (each.status !== "running") excess++;
  for (const [id, each] of jobs) {
    if (excess <= 0) return;
    if (each.status === "running") continue;
    jobs.delete(id);
    excess--;
  }
};

export interface ThreadState {
  readonly sessionId: string;
  providerThread: OrchestrationV2ProviderThread;
  publishedBackgroundWork?: boolean;
  sessionScopedBackground?: boolean;
  readonly imageJobs: Map<string, ImageJob>;
  goalRevision: number;
  goalFresh: boolean;
  goalRefreshing: boolean;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  active: ActiveTurn | undefined;
  model: ModelRef | undefined;
  /** Locally ended but possibly live; consume its next execution end without settling a new turn. */
  unsettled: boolean;
  /** A late first start belongs to the failed prompt; only a subsequent start proves a lost end. */
  unsettledStarted: boolean;
  /** Execution starts seen; lets a check that awaited OpenCode notice a run that began meanwhile. */
  starts: number;
  directory: string;
  agent: string;
  title: string | undefined;
  rules: ReadonlyArray<Rule> | undefined;
  policy: RulesPolicy;
  readonly grants: Array<Rule>;
  readonly calls: Map<string, SubagentCall>;
  subagent:
    | {
        call: SubagentCall;
        readonly appThread: OrchestrationV2AppThread;
        turns: number;
        prompt: string | undefined;
        queued: string | undefined;
      }
    | undefined;
  readonly wakes: Array<Wake>;
  readonly reports: Map<
    string,
    {
      readonly inboxId: string;
      readonly childId: string;
      readonly report: BackgroundWorkReport;
      readonly text: string;
    }
  >;
  readonly stoppedChildren: Set<string>;
  readonly strandedSteers: Set<string>;
  /** Prompts other clients queued while no GOAT turn ran, shown once delivered; `leads` the next wake if no report preceded it. */
  readonly externalPrompts: Map<string, { readonly text: string; leads: boolean }>;
  mcp:
    | {
        readonly name: string;
        readonly directory: string;
        readonly credential: string;
        readonly endpoint: string;
      }
    | undefined;
  /** The managed Cua Driver as registered for this thread; `key` names its daemon generation. */
  cua: { readonly name: string; readonly directory: string; readonly key: string } | undefined;
  instructions: string | undefined;
  /** Digest of the last successfully installed value; memory bodies are never retained locally. */
  memoryDigest: string | undefined;
}

export type TurnTerminal =
  | { readonly status: "completed" | "interrupted" }
  | { readonly status: "failed"; readonly failure: ReturnType<typeof makeProviderFailure> };

export type NativeForm = EventOf<"form.created">["data"]["form"];

export interface PendingRequest {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
  readonly node: OrchestrationV2ExecutionNode;
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly sessionId: string;
  answering: boolean;
  readonly native:
    | {
        readonly type: "permission";
        readonly id: string;
        readonly action: string;
        readonly resources: ReadonlyArray<string>;
        readonly save: ReadonlyArray<string>;
      }
    | { readonly type: "form"; readonly id: string; readonly form: NativeForm };
}

export const makeNewThreadState =
  (input: { readonly runtimePolicy: ThreadState["policy"] }) =>
  (
    sessionId: string,
    providerThread: OrchestrationV2ProviderThread,
    directory: string,
    subagent: ThreadState["subagent"],
  ): ThreadState => ({
    sessionId,
    providerThread,
    imageJobs: new Map(),
    goalRevision: 0,
    goalFresh: false,
    goalRefreshing: false,
    providerTurns: new Map(),
    active: undefined,
    model: undefined,
    unsettled: false,
    unsettledStarted: false,
    starts: 0,
    directory,
    agent: "build",
    title: undefined,
    rules: undefined,
    policy: input.runtimePolicy,
    grants: [],
    calls: new Map(),
    subagent,
    wakes: [],
    reports: new Map(),
    stoppedChildren: new Set(),
    strandedSteers: new Set(),
    externalPrompts: new Map(),
    mcp: undefined,
    cua: undefined,
    instructions: undefined,
    memoryDigest: undefined,
  });
