import type { MemoryRevisionId, TurnMemoryResult } from "@goat/contracts";
import { goatCallTarget } from "@goat/contracts/agentSurface/callArguments";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";

export const installQuestion =
  "How do I install this project's dependencies? Reply with the install command only.";

type ToolCall = { readonly toolName: string | null; readonly input: unknown };

function isRecallCall({ toolName, input }: ToolCall) {
  // The adapters expose a bare name or prefix it with the MCP server.
  const tool = toolName?.replace(/^(?:mcp__goat__|goat[._](?=goat_|memory_))/, "");
  if (tool === "memory_recall" || tool === "goat_memory_recall") return true;
  if (tool !== "goat_call") return false;
  const { path } = goatCallTarget(input);
  return typeof path === "string" && resolveAgentSurfaceEntry(path)?.path === "memory.recall";
}

export function confirmsRecall(
  request: { requestKind: string; appName?: string | undefined; prompt?: string | undefined },
  running: readonly ToolCall[],
) {
  return (
    request.requestKind === "mcp-elicitation" &&
    request.appName === "goat" &&
    request.prompt?.includes('"goat_call"') === true &&
    running.length === 1 &&
    running[0] !== undefined &&
    isRecallCall(running[0])
  );
}

export function summarizeNaturalTurn(input: {
  answer: string;
  memoryId: string;
  previousRevision: MemoryRevisionId | null;
  currentRevision: MemoryRevisionId;
  expected: "npm" | "pnpm";
  receipt: TurnMemoryResult;
  tools: readonly ToolCall[];
}) {
  const { receipt, answer } = input;
  const revisions = (kind: "automatic" | "recall") =>
    receipt.events
      .filter((event) => event.kind === kind)
      .flatMap((event) =>
        event.items
          .filter((item) => item.memoryId === input.memoryId)
          .map((item) => item.revisionId),
      );
  const automatic = revisions("automatic");
  const recalled = revisions("recall");
  const recallToolCalls = input.tools.filter(isRecallCall).length;
  const recallEvents = receipt.events.filter((event) => event.kind === "recall").length;
  const incomplete = Boolean(
    receipt.incomplete || receipt.truncated || recallToolCalls > recallEvents,
  );
  // Only a single, unambiguous command counts. Preserve the raw answer for other wording.
  const command = answer
    .trim()
    .replace(/^```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n```$/i, "$1")
    .replace(/^`([^`\n]+)`$/, "$1")
    .trim();
  const manager = /^(npm|pnpm) (?:install|i)$/.exec(command)?.[1];
  const evidence =
    automatic.includes(input.currentRevision) || recalled.includes(input.currentRevision);
  const outcome =
    manager === input.expected
      ? evidence
        ? "grounded-current"
        : incomplete
          ? "evidence-incomplete"
          : "unsupported-current"
      : manager && input.previousRevision
        ? "stale"
        : "other-answer";
  return { answer, outcome, automatic, recalled, recallEvents, recallToolCalls, incomplete };
}
