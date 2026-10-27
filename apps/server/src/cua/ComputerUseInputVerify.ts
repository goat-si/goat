/**
 * After input the driver answered "unverifiable", diff the window against the agent's last tree
 * read. A changed tree confirms it; the re-read retires old tokens, so the answer names the new
 * snapshot_id.
 * @module ComputerUseInputVerify
 */
// Driver lines are forwarded as written; only the fields named here are read or added.
// @effect-diagnostics preferSchemaOverJson:off
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import type { ReplySink } from "./ComputerUseLeaseProxyOptions.ts";
import { targetOf } from "./computerUseTarget.ts";

/** Input whose effect a tree diff can show. */
export const VERIFIABLE_INPUT_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "double_click",
  "right_click",
  "press_key",
  "hotkey",
  "scroll",
  "type_text",
  "set_value",
  "drag",
]);

/** Arguments of an agent's tree read that a diff read must repeat to diff against it. */
const SCOPE_KEYS = ["session", "query", "max_elements", "max_depth"] as const;

/** The longest diff text added to an answer. */
const MAX_DIFF_CHARS = 6000;

/** How long the read-back may take before the input's answer goes out without it. */
export const VERIFY_READ_TIMEOUT_MS = 4000;

export type TreeRead = Readonly<Record<string, unknown>> & {
  readonly pid: number;
  readonly window_id: number;
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const parse = (line: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    return record(JSON.parse(line));
  } catch {
    return undefined;
  }
};

/** The scope of an agent's get_window_state that read a tree, or undefined. */
export function treeReadOf(args: unknown): TreeRead | undefined {
  const given = record(args);
  const target = targetOf(args);
  if (target === undefined || given?.include_accessibility_tree === false) return undefined;
  const scope: Record<string, unknown> = { pid: target.pid, window_id: target.windowId };
  for (const key of SCOPE_KEYS) if (given?.[key] !== undefined) scope[key] = given[key];
  return scope as TreeRead;
}

/** Whether a driver reply to an input call left its effect unverified. */
export function replyUnverified(line: string): boolean {
  const result = record(parse(line)?.result);
  return (
    result !== undefined &&
    result.isError !== true &&
    record(result.structuredContent)?.effect === "unverifiable"
  );
}

/** The proxy's own diff read of a window the agent read before. */
export function diffReadLine(id: string, read: TreeRead): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "get_window_state",
      arguments: { ...read, include_screenshot: false, since: "latest" },
    },
  });
}

const textOf = (result: Readonly<Record<string, unknown>> | undefined) =>
  (Array.isArray(result?.content) ? result.content : [])
    .map((block: unknown) => record(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => String(block?.text))
    .join("\n");

/**
 * The input's answer with the diff read's outcome added, or the answer unchanged when the read
 * failed. Only "diff" and "too_much_changed" confirm; "no_change" says nothing moved in the tree;
 * a fallback full read only names the new snapshot.
 */
export function withTreeDiff(line: string, diff: unknown): string {
  const message = parse(line);
  const result = record(message?.result);
  const diffResult = record(record(diff)?.result);
  if (message === undefined || result === undefined || diffResult === undefined) return line;
  if (diffResult.isError === true) return line;
  const diffStructured = record(diffResult.structuredContent) ?? {};
  const status = diffStructured.since_status;
  const snapshotId = diffStructured.snapshot_id;
  if (typeof snapshotId !== "string") return line;
  const changed = status === "diff" || status === "too_much_changed";
  const unchanged = status === "no_change";
  const structured = record(result.structuredContent) ?? {};
  let diffText = textOf(diffResult);
  if (diffText.length > MAX_DIFF_CHARS)
    diffText =
      diffText.slice(0, MAX_DIFF_CHARS) + "\n… (diff cut short; read the window for the rest)";
  const lead = changed
    ? "GOAT re-read the window after this input and its accessibility tree changed, so the input landed."
    : unchanged
      ? "GOAT re-read the window after this input and its accessibility tree did not change. The input may still have changed only pixels; check a screenshot before resending."
      : "GOAT re-read the window after this input as a full read.";
  const note = `${lead} The window's snapshot is now ${snapshotId}: earlier element tokens are stale, use ${snapshotId}:N.`;
  const content = Array.isArray(result.content) ? result.content : [];
  return JSON.stringify({
    ...message,
    result: {
      ...result,
      content: [
        ...content,
        { type: "text", text: diffText.length > 0 ? `${note}\n${diffText}` : note },
      ],
      structuredContent: {
        ...structured,
        ...(changed ? { effect: "confirmed", verified: true, verified_by: "goat_ax_diff" } : {}),
        ...(changed || unchanged ? { ax_changed: changed } : {}),
        snapshot_id: snapshotId,
        since_status: status,
      },
    },
  });
}

/**
 * Remembers the agent's tree reads per window and wraps the reply sink of an input call so an
 * unverified answer is re-read before it goes out. The re-read is forked: its answer comes back
 * through the same driver output the caller is processing.
 */
export const makeInputVerifier = (input: {
  readonly enabled: boolean;
  readonly ownAnswers: Map<string, Deferred.Deferred<Envelope | undefined>>;
  readonly ended: Deferred.Deferred<unknown>;
  readonly nextId: () => string;
  readonly scope: Scope.Scope;
  readonly live: (child: Running) => boolean;
}) => {
  const reads = new Map<number, TreeRead>();
  const ask = Effect.fn("ComputerUseInputVerify.ask")(function* (child: Running, read: TreeRead) {
    const id = input.nextId();
    const answered = yield* Deferred.make<Envelope | undefined>();
    input.ownAnswers.set(id, answered);
    yield* child.driver.send(diffReadLine(id, read));
    const reply = yield* Effect.raceFirst(
      Deferred.await(answered),
      Deferred.await(input.ended).pipe(Effect.as(undefined)),
    ).pipe(Effect.timeoutOption(VERIFY_READ_TIMEOUT_MS));
    input.ownAnswers.delete(id);
    return Option.getOrUndefined(reply);
  });
  return {
    /** A fresh driver child has no snapshots to diff against. */
    clear: () => reads.clear(),
    /** Records an answered get_window_state as the window's baseline. */
    answered: (tool: string | undefined, args: unknown, failed: boolean) => {
      const read = tool === "get_window_state" && !failed ? treeReadOf(args) : undefined;
      if (read !== undefined) reads.set(read.window_id, read);
    },
    wrap: (sink: ReplySink, tool: unknown, args: unknown, child: Running): ReplySink => {
      const windowId = targetOf(args)?.windowId;
      if (!input.enabled || typeof tool !== "string" || !VERIFIABLE_INPUT_TOOLS.has(tool))
        return sink;
      if (windowId === undefined) return sink;
      return {
        answer: (line, status, context) => {
          const read = reads.get(windowId);
          if (read === undefined || !replyUnverified(line) || !input.live(child))
            return sink.answer(line, status, context);
          return ask(child, read).pipe(
            Effect.map((diff) => (diff === undefined ? line : withTreeDiff(line, diff))),
            Effect.catchCause(() => Effect.succeed(line)),
            Effect.flatMap((final) => sink.answer(final, status, context)),
            Effect.forkIn(input.scope),
          );
        },
      };
    },
  };
};
