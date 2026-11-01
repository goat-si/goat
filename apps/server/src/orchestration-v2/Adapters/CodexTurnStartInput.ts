import type { ModelSelection } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as CodexSchema from "effect-codex-app-server/schema";

/** What one Codex turn start is built from. */
export interface CodexTurnStartInput {
  readonly nativeThreadId: string;
  readonly codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly hasGoatMcp?: boolean;
  readonly browserToolsAvailable?: boolean;
  readonly deviceToolsAvailable?: boolean;
  /** The managed `cua-driver` MCP server is attached to this thread. */
  readonly computerUse?: boolean;
  readonly screenCode?: boolean;
  /** The installed screen-code SKILL.md the turn's screen entry points to. */
  readonly screenCodeSkillPath?: string | undefined;
  readonly computerUseDeferred?: boolean;
  /** ChatGPT token sharing does not accept service tiers. */
  readonly omitServiceTier?: boolean;
  readonly memoryContext?: ProviderAdapter.ProviderAdapterV2TurnInput["memoryContext"];
  readonly clearMemoryContext?: boolean;
  /** What the thread's MCP Apps want the agent to know (`ui/update-model-context`). */
  readonly appContext?: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"];
}
