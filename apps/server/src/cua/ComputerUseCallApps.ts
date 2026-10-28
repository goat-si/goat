// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off -- Reads display fields from a driver answer; a synchronous hash keys a cell's source.
/**
 * The app or page a computer use call acted on, for its timeline name and icon. Lease proxies label
 * the app each pid runs and screen hosts each target id they bind; a pid or target id names one
 * thing whichever thread acts on it, so both maps are host-wide. Display only; no window text.
 *
 * @module ComputerUseCallApps
 */
import * as NodeCrypto from "node:crypto";
import type {
  ComputerUseCallAppLabel,
  OrchestrationV2TurnItem,
  ToolActivityNativeAppReference,
} from "@goat/contracts";
import { COMPUTER_USE_TOOL_SOURCE, cuaDriverToolName } from "@goat/shared/toolActivity";
import * as Context from "effect/Context";

import { targetPid } from "./ComputerUseScope.ts";

const MAX_APPS = 512;
const MAX_SCREEN_TARGETS = 1024;
const MAX_SCREEN_CELLS = 512;
const MAX_ANSWER_CHARS = 65_536;
// A screen cell's result holds its value, console and up to 64 receipts.
const MAX_SCREEN_ANSWER_CHARS = 512 * 1024;
const APP_ID = /^[A-Za-z0-9._-]+$/u;
// The GOAT server prefixes resolveGoatMcpToolName in @goat/shared accepts: `goat.tool` (Codex,
// ACP), `mcp__goat__tool` (Claude, Cursor, Pi) and `goat-<thread>_tool` (OpenCode 2).
const SCREEN_RUN_TOOL =
  /^(?:(?:mcp[-_]{1,2})?goat(?:__|[-_.:/ ]|\s*·\s*)|goat-\S+_)?goat_screen_run$/iu;

/** What a screen host bound a cell target to: a desktop app, or a tab showing a page. */
export type ScreenTargetLabel =
  | {
      readonly kind: "app";
      readonly bundleId?: string | undefined;
      readonly name?: string | undefined;
    }
  | { readonly kind: "tab"; readonly pageUrl: string | null | undefined };

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : undefined;

/** The tool and arguments of a cua-driver call; ACP children keep it in {server, tool, arguments}. */
function driverCall(item: OrchestrationV2TurnItem) {
  if (item.type !== "dynamic_tool") return undefined;
  const input = record(item.input);
  const envelope = input?.server === "cua-driver" && typeof input.tool === "string";
  const tool = cuaDriverToolName(item.toolName);
  if (envelope) return { tool: tool ?? String(input.tool), args: record(input.arguments) };
  return tool === undefined ? undefined : { tool, args: input };
}

/** A driver answer's fields: structured content, or the JSON text a provider kept as a string. */
function answerFields(
  output: unknown,
  maxChars = MAX_ANSWER_CHARS,
  depth = 0,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof output === "string") {
    if (output.length > maxChars) return undefined;
    // OpenCode 2 joins a result's text blocks, so its JSON can follow the screen API's text.
    const json = output.trimStart().startsWith("{")
      ? output
      : output.slice(output.lastIndexOf("\n") + 1);
    if (!json.trimStart().startsWith("{")) return undefined;
    try {
      return record(JSON.parse(json));
    } catch {
      return undefined;
    }
  }
  const object = record(output);
  const structured = record(object?.structuredContent);
  if (structured !== undefined) return structured;
  const blocks = Array.isArray(output) ? output : object?.content;
  if (!Array.isArray(blocks) || depth > 0) return object;
  for (const block of blocks.slice(0, 8)) {
    // Cursor nests a text block's text as {text: {text}}; ACP wraps the block as {type: "content"}.
    const part = record(block)?.type === "content" ? record(record(block)?.content) : record(block);
    const blockText = part?.type === "text" ? part.text : record(part?.text)?.text;
    const fields = typeof blockText === "string" ? answerFields(blockText, maxChars, 1) : undefined;
    if (fields !== undefined) return fields;
  }
  return object;
}

/**
 * The targets a screen cell's receipts name, in call order; a failed or refused cell's error lists
 * its receipts too. Undefined when the provider kept neither a result nor an error.
 */
function receiptTargetIds(item: OrchestrationV2TurnItem): readonly string[] | undefined {
  if (item.type !== "dynamic_tool") return undefined;
  const fields = answerFields(item.output, MAX_SCREEN_ANSWER_CHARS);
  if (!Array.isArray(fields?.journal) && typeof fields?.code !== "string") return undefined;
  const journal = Array.isArray(fields?.journal) ? fields.journal : [];
  const receipts = [
    ...journal.map((entry) => record(record(entry)?.receipt)),
    ...(Array.isArray(fields?.receipts) ? fields.receipts.map(record) : []),
    fields,
  ];
  return receipts.flatMap((receipt) => text(receipt?.targetId, 200) ?? []);
}

const cellKey = (threadId: string, source: string) =>
  `${threadId}\u0000${NodeCrypto.createHash("sha256").update(source).digest("hex")}`;

/** A finished screen cell, with the code it ran in whichever envelope its provider kept. */
function finishedScreenCell(item: OrchestrationV2TurnItem) {
  if (item.type !== "dynamic_tool" || !SCREEN_RUN_TOOL.test(item.toolName ?? "")) return undefined;
  if (item.status !== "completed" && item.status !== "failed") return undefined;
  const input = record(item.input);
  const code = input?.code ?? record(input?.arguments)?.code;
  return { code: typeof code === "string" ? code : undefined };
}

function websiteUrl(value: unknown) {
  const raw = text(value, 4096);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** An item presented as the app a label names, or as it came when the label names none. */
function asApp(
  item: OrchestrationV2TurnItem,
  label: ComputerUseCallAppLabel | undefined,
): OrchestrationV2TurnItem {
  const appId =
    label?.bundleId !== undefined && APP_ID.test(label.bundleId) ? label.bundleId : undefined;
  // A bundle id stands in for a missing name only within the name's length limit.
  const name = label?.name ?? (appId !== undefined && appId.length <= 160 ? appId : undefined);
  if (name === undefined) return item;
  const app: ToolActivityNativeAppReference | undefined =
    appId !== undefined
      ? { _tag: "app-id", appId }
      : /[\\/]/u.test(name)
        ? undefined
        : { _tag: "display-name", displayName: name };
  const icon = app === undefined ? undefined : ({ _tag: "native-app", app } as const);
  return {
    ...item,
    toolSurface: "computer",
    ...(icon === undefined ? {} : { toolIcon: icon }),
    toolSource: {
      key:
        appId === undefined
          ? `native-app-name:${name.toLowerCase()}`
          : `native-app:${appId.toLowerCase()}`,
      name,
      kind: "computer",
      ...(icon === undefined ? {} : { icon }),
    },
  };
}

export const makeCallApps = () => {
  const byPid = new Map<number, ComputerUseCallAppLabel>();
  const screenTargets = new Map<
    string,
    | { readonly kind: "app"; readonly label: ComputerUseCallAppLabel }
    | { readonly kind: "tab"; readonly pageUrl: string }
  >();
  // The targets each cell acted on, in order, kept by the server: providers may hand back a
  // summary or a truncated tail in place of the cell's receipts, and receipts keep only 16 calls.
  const screenCells = new Map<string, readonly string[]>();
  const labelOf = (
    tool: string,
    args: Readonly<Record<string, unknown>> | undefined,
    output: unknown,
  ) => {
    if (tool === "launch_app") {
      const bundleId = text(args?.bundle_id, 255);
      // A launch by bundle id learns the app's name from its own answer.
      const launched = answerFields(output);
      const name =
        text(args?.name, 160) ??
        (bundleId !== undefined && text(launched?.bundle_id, 255) === bundleId
          ? text(launched?.name, 160)
          : undefined);
      if (bundleId !== undefined || name !== undefined)
        return {
          ...(bundleId === undefined ? {} : { bundleId }),
          ...(name === undefined ? {} : { name }),
        };
    }
    const pid = targetPid(args);
    return pid === undefined ? undefined : byPid.get(pid);
  };
  return {
    /** The bundle id of the app a pid runs, when a proxy learned one; none on Linux or Windows. */
    bundleIdOf: (pid: number) => {
      const bundleId = byPid.get(pid)?.bundleId;
      return bundleId !== undefined && APP_ID.test(bundleId) ? bundleId : undefined;
    },
    /**
     * Keeps the app an admitted call's pid runs, as its proxy labelled it. A call whose proxy
     * could not label its pid forgets it, so a pid reused by another app never shows the old one.
     */
    admitted: (args: unknown, label: ComputerUseCallAppLabel | undefined) => {
      const pid = targetPid(record(args));
      if (pid === undefined) return;
      byPid.delete(pid);
      if (label === undefined) return;
      byPid.set(pid, label);
      const oldest = byPid.keys().next();
      if (byPid.size > MAX_APPS && oldest.done !== true) byPid.delete(oldest.value);
    },
    /**
     * Keeps what a screen host bound a target id to; a tab's later label follows its navigation.
     * A label without an app name, bundle id or web page forgets the id.
     */
    screenTarget: (targetId: string, label: ScreenTargetLabel) => {
      screenTargets.delete(targetId);
      if (label.kind === "app") {
        const bundleId = text(label.bundleId, 255);
        const name = text(label.name, 160);
        if (bundleId === undefined && name === undefined) return;
        screenTargets.set(targetId, {
          kind: "app",
          label: {
            ...(bundleId === undefined ? {} : { bundleId }),
            ...(name === undefined ? {} : { name }),
          },
        });
      } else {
        const pageUrl = websiteUrl(label.pageUrl);
        if (pageUrl === undefined) return;
        screenTargets.set(targetId, { kind: "tab", pageUrl });
      }
      const oldest = screenTargets.keys().next();
      if (screenTargets.size > MAX_SCREEN_TARGETS && oldest.done !== true)
        screenTargets.delete(oldest.value);
    },
    /**
     * Keeps the targets a finished cell acted on, in first-use order, for its row to name. A cell
     * that acted on none forgets an earlier cell with the same code.
     */
    screenCell: (threadId: string, source: string, targetIds: readonly string[]) => {
      const key = cellKey(threadId, source);
      screenCells.delete(key);
      if (targetIds.length === 0) return;
      screenCells.set(key, targetIds.slice(0, 64));
      const oldest = screenCells.keys().next();
      if (screenCells.size > MAX_SCREEN_CELLS && oldest.done !== true)
        screenCells.delete(oldest.value);
    },
    /**
     * A cua-driver call presented as the app it names or whose pid a proxy labelled; a finished
     * screen cell as the first app it acted on, else the first page, from the server's record of
     * the cell or else its receipts. Anything else, or a call whose provider named its app, stays.
     */
    present: (item: OrchestrationV2TurnItem): OrchestrationV2TurnItem => {
      const cell = finishedScreenCell(item);
      const recorded =
        cell?.code === undefined ? undefined : screenCells.get(cellKey(item.threadId, cell.code));
      const receipts = cell === undefined ? undefined : receiptTargetIds(item);
      // The record is a cell with this code, which may not be this call: kept receipts decide,
      // and the record stands in only where it agrees with them or none survived.
      const targetIds =
        receipts === undefined
          ? (recorded ?? [])
          : recorded !== undefined &&
              receipts.length > 0 &&
              receipts.every((id) => recorded.includes(id))
            ? recorded
            : receipts;
      const targets = targetIds.flatMap((id) => screenTargets.get(id) ?? []);
      const app = targets.find((target) => target.kind === "app");
      if (app !== undefined) return asApp(item, app.label);
      const tab = targets.find((target) => target.kind === "tab");
      if (tab !== undefined)
        return { ...item, toolIcon: { _tag: "website", pageUrl: tab.pageUrl } };
      const call = driverCall(item);
      if (call === undefined) return item;
      if (
        item.toolSource?.kind === "computer" &&
        item.toolSource.key !== COMPUTER_USE_TOOL_SOURCE.key
      )
        return item;
      return asApp(
        item,
        labelOf(call.tool, call.args, item.type === "dynamic_tool" ? item.output : undefined),
      );
    },
  };
};

export class ComputerUseCallApps extends Context.Reference<ReturnType<typeof makeCallApps>>(
  "goat/cua/ComputerUseCallApps",
  { defaultValue: makeCallApps },
) {}
