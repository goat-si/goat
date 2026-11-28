import * as Predicate from "effect/Predicate";

import type { AcpToolCallState } from "@goat/provider-acp/server/runtimeModel";

const ANTIGRAVITY_SWARM_TOOLS = new Set([
  "swarm",
  "post_message",
  "read_board",
  "swarm_wait",
] as const);

export type AntigravitySwarmToolName = "swarm" | "post_message" | "read_board" | "swarm_wait";

const LEGACY_SWARM_TITLE_TO_TOOL = new Map<string, AntigravitySwarmToolName>([
  ["Running swarm", "swarm"],
  ["Run swarm?", "swarm"],
  ["Run swarm", "swarm"],
  ["Running post_message", "post_message"],
  ["Run post_message?", "post_message"],
  ["Run post_message", "post_message"],
  ["Running read_board", "read_board"],
  ["Run read_board?", "read_board"],
  ["Run read_board", "read_board"],
  ["Running swarm_wait", "swarm_wait"],
  ["Run swarm_wait?", "swarm_wait"],
  ["Run swarm_wait", "swarm_wait"],
]);

export function readAntigravityToolMeta(toolCall: AcpToolCallState, rawPayload?: unknown): unknown {
  const update = Predicate.isObject(rawPayload) ? rawPayload.update : undefined;
  if (Predicate.isObject(update) && update._meta !== undefined) return update._meta;
  return toolCall.data.meta ?? toolCall.data._meta;
}

function isSwarmToolName(value: unknown): value is AntigravitySwarmToolName {
  return (
    typeof value === "string" && ANTIGRAVITY_SWARM_TOOLS.has(value as AntigravitySwarmToolName)
  );
}

export function identifyAntigravitySwarmToolCall(
  toolCall: AcpToolCallState,
  rawPayload?: unknown,
):
  | {
      readonly tool: AntigravitySwarmToolName;
      readonly action?: string | undefined;
      readonly mcp: boolean;
    }
  | undefined {
  const meta = readAntigravityToolMeta(toolCall, rawPayload);
  const mcp = Predicate.isObject(meta) && meta.is_mcp_tool_call === true;
  const antigravity = Predicate.isObject(meta) ? meta.antigravity : undefined;
  const swarmMeta = Predicate.isObject(antigravity) ? antigravity.swarm : undefined;
  const metaTool = Predicate.isObject(swarmMeta) ? swarmMeta.tool : undefined;
  const tool = isSwarmToolName(metaTool)
    ? metaTool
    : toolCall.title === undefined
      ? undefined
      : LEGACY_SWARM_TITLE_TO_TOOL.get(toolCall.title.trim());
  if (tool === undefined) return undefined;
  if (
    (tool === "swarm" || tool === "post_message") &&
    toolCall.kind !== undefined &&
    toolCall.kind !== "other"
  ) {
    return undefined;
  }
  if (
    tool === "read_board" &&
    toolCall.kind !== undefined &&
    toolCall.kind !== "other" &&
    toolCall.kind !== "read"
  ) {
    return undefined;
  }
  if (
    tool === "swarm_wait" &&
    toolCall.kind !== undefined &&
    toolCall.kind !== "other" &&
    toolCall.kind !== "think"
  ) {
    return undefined;
  }
  const metaAction =
    Predicate.isObject(swarmMeta) && typeof swarmMeta.action === "string"
      ? swarmMeta.action.trim()
      : undefined;
  const rawInput = toolCall.data.rawInput;
  const inputAction =
    Predicate.isObject(rawInput) && typeof rawInput.action === "string"
      ? rawInput.action.trim()
      : undefined;
  const action = metaAction || inputAction;
  return { tool, ...(action === undefined ? {} : { action }), mcp };
}

function formatSwarmToolPresentation(
  tool: AntigravitySwarmToolName,
  action: string | undefined,
  rawInput: unknown,
): { readonly kind: NonNullable<AcpToolCallState["kind"]>; readonly title: string } {
  const input = Predicate.isObject(rawInput) ? rawInput : undefined;
  const cleanHandle = (value: unknown) =>
    typeof value === "string" ? value.trim().replace(/^@/, "") : "";
  const cleanChannel = (value: unknown) =>
    typeof value === "string" ? value.trim().replace(/^#/, "") : "";

  switch (tool) {
    case "swarm": {
      const name = cleanHandle(input?.name);
      switch (action?.toLowerCase()) {
        case "add": {
          const tasks = Array.isArray(input?.tasks) ? input.tasks.length : 0;
          const n =
            typeof input?.n === "number" && Number.isFinite(input.n) ? Math.trunc(input.n) : 0;
          const count = Math.max(tasks, n);
          if (count > 1 && name.length > 0) {
            return { kind: "other", title: `Add ${count} swarm workers (@${name}-1..${count})` };
          }
          if (count > 1) return { kind: "other", title: `Add ${count} swarm workers` };
          return {
            kind: "other",
            title: name.length > 0 ? `Add swarm worker @${name}` : "Add swarm worker",
          };
        }
        case "kill":
          return {
            kind: "other",
            title: name.length > 0 ? `Stop swarm worker @${name}` : "Stop swarm worker",
          };
        case "status":
          return { kind: "other", title: "Check swarm status" };
        case "models":
          return { kind: "other", title: "List swarm models" };
        case "model": {
          const model = typeof input?.model === "string" ? input.model.trim() : "";
          if (name.length > 0 && model.length > 0) {
            return { kind: "other", title: `Switch @${name} model to ${model}` };
          }
          if (name.length > 0) return { kind: "other", title: `Switch swarm model for @${name}` };
          if (model.length > 0) return { kind: "other", title: `Switch swarm model to ${model}` };
          return { kind: "other", title: "Switch swarm model" };
        }
        case "title": {
          const title = typeof input?.title === "string" ? input.title.trim() : "";
          return {
            kind: "other",
            title: title.length > 0 ? `Set swarm title "${title}"` : "Set swarm title",
          };
        }
        case "channel": {
          const op = typeof input?.op === "string" ? input.op.trim() : "";
          const channel = cleanChannel(input?.channel);
          if (op.length > 0 && channel.length > 0) {
            return { kind: "other", title: `Swarm channel ${op} #${channel}` };
          }
          return {
            kind: "other",
            title: op.length > 0 ? `Swarm channel ${op}` : "Manage swarm channels",
          };
        }
        case "join": {
          const swarm = typeof input?.swarm === "string" ? input.swarm.trim() : "";
          return {
            kind: "other",
            title: swarm.length > 0 ? `Join swarm ${swarm}` : "Join swarm",
          };
        }
        default:
          return { kind: "other", title: "Run swarm" };
      }
    }
    case "post_message": {
      const channel = cleanChannel(input?.channel);
      return {
        kind: "other",
        title:
          channel.length > 0 && channel !== "main" ? `Post to #${channel}` : "Post to swarm board",
      };
    }
    case "read_board": {
      if (input?.status === true) return { kind: "other", title: "Read swarm status" };
      const channel = cleanChannel(input?.channel);
      return {
        kind: "other",
        title:
          channel.length > 0 && channel !== "main" && channel !== "*"
            ? `Read #${channel}`
            : "Read swarm board",
      };
    }
    case "swarm_wait":
      return { kind: "think", title: "Wait for swarm board" };
  }
}

export function normalizeAntigravitySwarmToolPresentation(
  toolCall: AcpToolCallState,
  boundText: (text: string) => string,
): AcpToolCallState {
  const swarm = identifyAntigravitySwarmToolCall(toolCall);
  if (swarm === undefined || swarm.mcp) return toolCall;
  const legacyTool =
    toolCall.title === undefined
      ? undefined
      : LEGACY_SWARM_TITLE_TO_TOOL.get(toolCall.title.trim());
  if (legacyTool === undefined) return toolCall;
  const presentation = formatSwarmToolPresentation(
    swarm.tool,
    swarm.action,
    toolCall.data.rawInput,
  );
  const existingMeta = Predicate.isObject(toolCall.data.meta) ? toolCall.data.meta : {};
  const existingAntigravity = Predicate.isObject(existingMeta.antigravity)
    ? existingMeta.antigravity
    : {};
  return {
    ...toolCall,
    kind: presentation.kind,
    title: boundText(presentation.title),
    data: {
      ...toolCall.data,
      meta: {
        ...existingMeta,
        antigravity: {
          ...existingAntigravity,
          swarm: {
            tool: swarm.tool,
            ...(swarm.action === undefined ? {} : { action: swarm.action }),
          },
        },
      },
    },
  };
}

export function antigravitySwarmAddChildSessionId(toolCall: AcpToolCallState): string | null {
  const output = toolCall.data.rawOutput;
  if (!Predicate.isObject(output) || typeof output.conversation_id !== "string") return null;
  const id = output.conversation_id.trim();
  return id.length > 0 ? id : null;
}

export function antigravitySwarmAddModel(toolCall: AcpToolCallState): string | null {
  const output = toolCall.data.rawOutput;
  if (Predicate.isObject(output) && typeof output.model === "string" && output.model.trim()) {
    return output.model.trim();
  }
  const input = toolCall.data.rawInput;
  if (Predicate.isObject(input) && typeof input.model === "string" && input.model.trim()) {
    return input.model.trim();
  }
  return null;
}
