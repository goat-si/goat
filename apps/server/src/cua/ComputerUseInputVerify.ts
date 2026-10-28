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

import { driverOutcomeSafety } from "./ComputerUseDriverOutcome.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import { PRIMITIVE_ID, type ReplySink } from "./ComputerUseLeaseProxyOptions.ts";
import { targetOf } from "./computerUseTarget.ts";

/** Input whose effect a tree diff can show. */
const VERIFIABLE_INPUT_TOOLS: ReadonlySet<string> = new Set([
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
const VERIFY_READ_TIMEOUT_MS = 4000;

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
function treeReadOf(args: unknown): TreeRead | undefined {
  const given = record(args);
  const target = targetOf(args);
  if (target === undefined || given?.include_accessibility_tree === false) return undefined;
  const scope: Record<string, unknown> = { pid: target.pid, window_id: target.windowId };
  for (const key of SCOPE_KEYS) if (given?.[key] !== undefined) scope[key] = given[key];
  return scope as TreeRead;
}

/** Whether a driver reply to an input call left its effect unverified. */
function replyUnverified(line: string): boolean {
  const result = record(parse(line)?.result);
  return (
    result !== undefined &&
    result.isError !== true &&
    record(result.structuredContent)?.effect === "unverifiable"
  );
}

/** The proxy's own diff read of a window the agent read before. */
function diffReadLine(id: string, read: TreeRead): string {
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

/** Whether a reply is an error, so it read nothing a diff could start from. */
function replyFailed(line: string): boolean {
  const message = parse(line);
  return message?.error !== undefined || record(message?.result)?.isError === true;
}

const textOf = (result: Readonly<Record<string, unknown>> | undefined) =>
  (Array.isArray(result?.content) ? result.content : [])
    .map((block: unknown) => record(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => String(block?.text))
    .join("\n");

/** A tree row's indentation and its [N] index; rows the driver cannot act on have none. */
type Row = { readonly index: number | undefined; readonly indent: number };

const ROW = /^( *)- (?:\[(\d+)\])?/u;

/** The rows of a tree read's reply, as the driver renders them, numbered or not. */
function rowsOf(line: string): ReadonlyArray<Row> {
  const rows: Array<Row> = [];
  for (const text of textOf(record(parse(line)?.result)).split("\n")) {
    const match = ROW.exec(text);
    if (match?.[1] !== undefined)
      rows.push({
        index: match[2] === undefined ? undefined : Number(match[2]),
        indent: match[1].length,
      });
  }
  return rows;
}

/** Rows indexed [start, end]: the target's own row and its subtree. */
type Neighbourhood = { readonly start: number; readonly end: number };

/**
 * Where in the read a change would show the input landed, or undefined when unknown. Siblings
 * and parents never count: macOS folds groups, so unrelated controls can share a parent. The
 * subtree ends at the next row, numbered or not, that is no deeper than the target.
 */
function neighbourhood(rows: ReadonlyArray<Row>, target: number): Neighbourhood | undefined {
  const at = rows.findIndex((row) => row.index === target);
  const row = rows[at];
  if (row === undefined) return undefined;
  let end = target;
  for (const each of rows.slice(at + 1)) {
    if (each.indent <= row.indent) break;
    if (each.index !== undefined) end = each.index;
  }
  return { start: target, end };
}

/** The element an input names, by token of the baseline snapshot or by index. */
function targetIndex(args: unknown, snapshotId: string | undefined): number | undefined {
  const given = record(args);
  if (typeof given?.element_index === "number") return given.element_index;
  const token = typeof given?.element_token === "string" ? given.element_token : undefined;
  const match = token === undefined ? undefined : /^(.+):(\d+)$/u.exec(token);
  return match?.[2] !== undefined && match[1] === snapshotId ? Number(match[2]) : undefined;
}

const REINDEXED = /^reindexed: \[(\d+)-\d+\]/u;

/**
 * Whether a diff's +, ~ or - rows touch the neighbourhood. + and ~ rows carry the new read's
 * numbers and - rows the old one's, so this holds only while the target kept its number: no row
 * up to it moved, and no numbered row before it came or went.
 */
function touches(diffText: string, around: Neighbourhood | undefined): boolean {
  if (around === undefined) return false;
  let near = false;
  for (const text of diffText.split("\n")) {
    const moved = REINDEXED.exec(text)?.[1];
    if (moved !== undefined && Number(moved) <= around.start) return false;
    const row = /^([+~-]) \[(\d+)\]/u.exec(text);
    if (row?.[2] === undefined) continue;
    const index = Number(row[2]);
    if (index < around.start && row[1] !== "~") return false;
    if (index >= around.start && index <= around.end) near = true;
  }
  return near;
}

/**
 * The input's answer with the diff read's outcome added, or the answer unchanged when the read
 * failed. Only a "diff" whose rows touch the target or its subtree confirms: a clock or spinner
 * elsewhere changes the tree too. "no_change" says nothing moved; a fallback full read, or most of
 * the tree changing, only names the new snapshot.
 */
function withTreeDiff(line: string, diff: unknown, around: Neighbourhood | undefined): string {
  const message = parse(line);
  const result = record(message?.result);
  const diffResult = record(record(diff)?.result);
  if (message === undefined || result === undefined || diffResult === undefined) return line;
  if (diffResult.isError === true) return line;
  const diffStructured = record(diffResult.structuredContent) ?? {};
  const status = diffStructured.since_status;
  const snapshotId = diffStructured.snapshot_id;
  if (typeof snapshotId !== "string") return line;
  const treeChanged = status === "diff" || status === "too_much_changed";
  const unchanged = status === "no_change";
  const structured = record(result.structuredContent) ?? {};
  let diffText = textOf(diffResult);
  const changed = status === "diff" && touches(diffText, around);
  if (diffText.length > MAX_DIFF_CHARS)
    diffText =
      diffText.slice(0, MAX_DIFF_CHARS) + "\n… (diff cut short; read the window for the rest)";
  const lead = changed
    ? "GOAT re-read the window after this input and its target, or what the target contains, changed, so the input landed."
    : treeChanged
      ? "GOAT re-read the window after this input; its accessibility tree changed, but not at this input's target, so it may or may not have landed. Check the target before resending."
      : unchanged
        ? "GOAT re-read the window after this input and its accessibility tree did not change. The input may still have changed only pixels; check a screenshot before resending."
        : "GOAT re-read the window after this input as a full read.";
  const note = `${lead} The window's snapshot is now ${snapshotId}: earlier element tokens are stale, use ${snapshotId}:N.`;
  const content = Array.isArray(result.content) ? result.content : [];
  const verified = {
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
        ...(treeChanged || unchanged ? { ax_changed: treeChanged } : {}),
        snapshot_id: snapshotId,
        since_status: status,
      },
    },
  };
  if (!changed) return JSON.stringify(verified);
  // The safety marked before the read-back said may-have-applied; the input is now confirmed.
  const safety = driverOutcomeSafety(undefined, verified);
  return JSON.stringify({
    ...verified,
    result: {
      ...verified.result,
      structuredContent: { ...verified.result.structuredContent, safety },
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
  readonly ended: Effect.Effect<unknown>;
  readonly nextId: () => string;
  readonly scope: Scope.Scope;
  readonly live: (child: Running) => boolean;
  /** The provider call a driver reply answers, while it is still outstanding. */
  readonly request: (
    id: unknown,
  ) => { readonly method: string; readonly tool?: string; readonly args?: unknown } | undefined;
}) => {
  /** Each window's last tree read, with the driver child that holds its snapshot. */
  const reads = new Map<
    number,
    {
      readonly read: TreeRead;
      readonly child: Running;
      readonly rows: ReadonlyArray<Row>;
      readonly snapshotId: string | undefined;
    }
  >();
  /** The window an element token's snapshot was read from, for a call that names no window. */
  const tokenWindow = (args: unknown): number | undefined => {
    const token = record(args)?.element_token;
    const snapshot = typeof token === "string" ? /^(.+):\d+$/u.exec(token)?.[1] : undefined;
    for (const [windowId, entry] of reads) if (entry.snapshotId === snapshot) return windowId;
    return undefined;
  };
  const ask = Effect.fn("ComputerUseInputVerify.ask")(function* (child: Running, read: TreeRead) {
    const id = input.nextId();
    const answered = yield* Deferred.make<Envelope | undefined>();
    input.ownAnswers.set(id, answered);
    yield* child.driver.send(diffReadLine(id, read));
    const reply = yield* Effect.raceFirst(
      Deferred.await(answered),
      input.ended.pipe(Effect.as(undefined)),
    ).pipe(Effect.timeoutOption(VERIFY_READ_TIMEOUT_MS));
    input.ownAnswers.delete(id);
    return Option.getOrUndefined(reply);
  });
  return {
    /**
     * Records a tree read the agent receives as its window's baseline. A screen-run cell is left
     * alone: it keeps its own observation and its tokens, which a re-read would retire mid-script.
     */
    wrap: (sink: ReplySink, message: Envelope | undefined, child: Running): ReplySink => {
      const tool = message?.params?.name;
      const primitive = typeof message?.id === "string" && message.id.startsWith(PRIMITIVE_ID);
      if (!input.enabled || primitive || typeof tool !== "string") return sink;
      const treeRead =
        tool === "get_window_state" ? treeReadOf(message?.params?.arguments) : undefined;
      if (treeRead !== undefined)
        return {
          answer: (line, status, context) => {
            if (!replyFailed(line)) {
              const snapshotId = record(
                record(parse(line)?.result)?.structuredContent,
              )?.snapshot_id;
              reads.set(treeRead.window_id, {
                read: treeRead,
                child,
                rows: rowsOf(line),
                snapshotId: typeof snapshotId === "string" ? snapshotId : undefined,
              });
            }
            return sink.answer(line, status, context);
          },
        };
      return sink;
    },
    /**
     * Handles a driver reply, re-reading first after unverified input. The call stays outstanding
     * and reserved meanwhile, so a pause, Stop or cancel answers it as any call with the driver.
     * The re-read's answer comes through the same driver output, so both run apart from that loop.
     */
    beforeReply: <E, R>(
      line: string,
      child: Running,
      handle: (line: string) => Effect.Effect<void, E, R>,
    ): Effect.Effect<void, E, R> => {
      const id = parse(line)?.id;
      const call = input.enabled && typeof id !== "object" ? input.request(id) : undefined;
      const primitive = typeof id === "string" && id.startsWith(PRIMITIVE_ID);
      if (
        call?.method !== "tools/call" ||
        primitive ||
        call.tool === undefined ||
        !VERIFIABLE_INPUT_TOOLS.has(call.tool)
      )
        return handle(line);
      const windowId = targetOf(call.args)?.windowId ?? tokenWindow(call.args);
      const baseline = windowId === undefined ? undefined : reads.get(windowId);
      if (baseline?.child !== child || !replyUnverified(line) || !input.live(child))
        return handle(line);
      return ask(child, baseline.read).pipe(
        // A pause, end or dropped lease stream during the read-back withholds what it saw.
        Effect.map((diff) => {
          if (diff === undefined || !input.live(child)) return line;
          const target = targetIndex(call.args, baseline.snapshotId);
          return withTreeDiff(
            line,
            diff,
            target === undefined ? undefined : neighbourhood(baseline.rows, target),
          );
        }),
        Effect.catchCause(() => Effect.succeed(line)),
        Effect.flatMap(handle),
        Effect.forkIn(input.scope),
        Effect.asVoid,
      );
    },
  };
};
