import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { ModelSelection, ProviderDriverKind, ThreadId } from "@goat/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { ACP_SESSION_MODE_OPTION_ID } from "./sessionConfig.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export function readAgentModes(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modeState: Effect.Success<AcpSessionRuntime.AcpSessionRuntime["Service"]["getModeState"]>,
) {
  const modes = new Map<string, string>();
  for (const option of options) {
    if (
      option.type === "select" &&
      (option.category === "mode" || option.category === "collaboration_mode")
    ) {
      modes.set(option.id, option.currentValue);
    }
  }
  const modeId = modeState?.currentModeId;
  if (modeId !== undefined && !modes.has(ACP_SESSION_MODE_OPTION_ID))
    modes.set(ACP_SESSION_MODE_OPTION_ID, modeId);
  return modes;
}

function agentModeSelectionChanges(
  selection: NonNullable<ModelSelection["options"]>,
  configured: ReadonlyMap<string, string>,
  live: ReadonlyMap<string, string>,
) {
  const changes: Array<{ id: string; from: string; to: string }> = [];
  const options = selection.map((option) => {
    const value = live.get(option.id);
    if (
      value === undefined ||
      typeof option.value !== "string" ||
      value === configured.get(option.id) ||
      value === option.value
    )
      return option;
    changes.push({ id: option.id, from: option.value, to: value });
    return { ...option, value };
  });
  return { changes, options };
}

export function makeAgentModeReporter(input: {
  driver: ProviderDriverKind;
  activeSelection: Ref.Ref<ModelSelection | null>;
  configuredModes: Ref.Ref<ReadonlyMap<string, string>>;
  readModes: Effect.Effect<Map<string, string>>;
  emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
}) {
  // This runs at turn settlement under the adapter's existing tracing boundary.
  return Effect.fnUntraced(function* (threadId: ThreadId) {
    const selection = yield* Ref.get(input.activeSelection);
    if (selection === null || selection.options === undefined) return;
    const configured = yield* Ref.get(input.configuredModes);
    const live = yield* input.readModes;
    const { changes, options } = agentModeSelectionChanges(selection.options, configured, live);
    if (changes.length === 0) return;
    yield* Ref.set(input.activeSelection, { ...selection, options });
    yield* Ref.set(input.configuredModes, live);
    yield* input.emit({
      type: "thread_model_selection.updated",
      driver: input.driver,
      threadId,
      instanceId: selection.instanceId,
      changes,
    });
  });
}
