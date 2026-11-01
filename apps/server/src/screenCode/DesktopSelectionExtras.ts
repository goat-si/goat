// @effect-diagnostics preferSchemaOverJson:off - Driver replies are bounded by the primitive channel.
/**
 * The driver's select_text and menu_bar_extras for desktop targets. A driver without them, or a
 * capability manifest that does not declare them, refuses the tool before running anything.
 */
import * as Effect from "effect/Effect";
import type { ComputerUsePrimitiveReply, ScreenHostCall, ScreenRunError } from "@goat/contracts";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";
import { driverOutcomeSafety } from "../cua/ComputerUseDriverOutcome.ts";
import { isReadOnlyCall } from "../cua/ComputerUseLeaseMessages.ts";
import {
  driverError,
  driverFailureNextStep,
  driverResult,
  driverValue,
  fail,
} from "./DesktopDriverReplies.ts";
import type { BoundWindow } from "./DesktopTargetHost.ts";
import type { ScreenHostContext, ScreenHostDispatchResult } from "./ScreenHostBridge.ts";

type Send = (
  tool: string,
  args: Record<string, unknown>,
  call: ScreenHostCall,
  context: ScreenHostContext,
  expectedConnectionGeneration?: string,
) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;

const SELECT_TEXT_UNSUPPORTED =
  "select_text is unavailable here: only the macOS driver has it, and this computer's driver lacks it or was started without it; nothing was sent. To replace a field's whole value, use setValue(target, value).";
const MENU_BAR_EXTRAS_UNSUPPORTED =
  "GOAT does not enable menu bar extras: the driver's one tool for them can also press status items other apps own, outside GOAT's app approvals, and cannot be limited to listing; nothing was sent. Bind an app window with screen.app() or hand the status item to the person.";

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const positive = (value: unknown): number | undefined => {
  const number = natural(value);
  return number !== undefined && number > 0 ? number : undefined;
};

const replyText = (reply: ComputerUsePrimitiveReply): string => {
  const content = object(reply.result)?.content;
  return (Array.isArray(content) ? content : [])
    .map((part) => object(part))
    .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
};

/**
 * The driver, or its capability manifest, does not offer the tool, and refused it before running
 * anything: an unknown or unclassified tool, or one outside the manifest. Any sign the call ran,
 * an effect other than refused or a possible commit, keeps the answer as the call's own.
 */
const toolUnavailable = (
  reply: ComputerUsePrimitiveReply,
  tool: string,
  args: Record<string, unknown>,
): boolean => {
  const result = object(reply.result);
  const structured = object(result?.structuredContent);
  if (reply.status !== "settled" || result?.isError !== true || reply.error !== undefined)
    return false;
  if (structured?.effect !== undefined && structured.effect !== "refused") return false;
  if (object(structured?.safety)?.possibleCommit === true) return false;
  if (driverOutcomeSafety(tool, reply, args).possibleCommit) return false;
  if (structured?.code === "unknown_tool") return true;
  const said = replyText(reply);
  return [
    `Unknown tool: ${tool}`,
    `tool '${tool}' is outside the capability manifest`,
    `tool '${tool}' has no reviewed risk classification`,
  ].some((sentence) => said.includes(sentence));
};

const unsupported = (nextStep: string, effect: "read" | "write"): ScreenRunError => ({
  ...fail("unsupported", nextStep),
  safety: classifyActionOutcome({ effect, status: "refused", dispatched: false }),
});

/**
 * A driver error as the call's failure, with its safety judged by tool and arguments. The driver
 * names a refused grant with permission_denied and no effect, which stays permission_denied. A
 * write that may have run, by any account of the reply, never reads as unsent.
 */
const driverFailure = (
  reply: ComputerUsePrimitiveReply,
  tool: string,
  args: Record<string, unknown>,
): ScreenRunError | undefined => {
  const error = driverError(reply);
  if (error === undefined) return undefined;
  const structured = object(object(reply.result)?.structuredContent);
  const code = structured?.code ?? object(structured?.refusal)?.code;
  const said = replyText(reply).split("\n", 1)[0]?.slice(0, 1000);
  const denied =
    error.code === "downstream_failure" &&
    code === "permission_denied" &&
    structured?.effect === undefined;
  const computed = driverOutcomeSafety(tool, reply, args);
  const mayHaveRun =
    error.effectStarted ||
    computed.possibleCommit ||
    object(structured?.safety)?.possibleCommit === true;
  const safety =
    mayHaveRun && !isReadOnlyCall(tool, args)
      ? classifyActionOutcome({ effect: "write", status: "indeterminate", dispatched: true })
      : computed;
  return {
    ...error,
    ...(denied ? { code: "permission_denied" as const, nextStep: said || error.nextStep } : {}),
    ...(safety.possibleCommit ? { code: "unknown_outcome" as const } : {}),
    nextStep: driverFailureNextStep(
      reply,
      denied ? { ...error, nextStep: said || error.nextStep } : error,
      safety.possibleCommit,
    ),
    safety,
    effectStarted: safety.possibleCommit,
  };
};

const SELECTION = new Set(["text", "cursor_before", "cursor_after"]);
const SELECT_TEXT_KEYS = new Set([
  "elementRef",
  "text",
  "occurrence",
  "prefix",
  "suffix",
  "selection",
]);

/** select_text's arguments for the bound window, or why there are none. */
export const selectTextArgs = (
  args: Record<string, unknown>,
  bound: BoundWindow,
  tokenOf: (element: Record<string, unknown>, bound: BoundWindow) => string | undefined,
): { readonly forwarded: Record<string, unknown> } | { readonly error: ScreenRunError } => {
  // A dropped misspelling would leave the driver's default, selecting the whole match.
  const unknown = Object.keys(args).find((key) => !SELECT_TEXT_KEYS.has(key));
  if (unknown !== undefined)
    return {
      error: fail(
        "invalid_argument",
        `selectText does not take ${unknown}. It takes occurrence, prefix, suffix, selection; nothing was sent.`,
      ),
    };
  const element = object(args.elementRef);
  if (element === undefined)
    return { error: fail("invalid_argument", "Name the text field: selectText(target, text).") };
  const token = tokenOf(element, bound);
  if (token === undefined) return { error: fail("stale_reference") };
  if (typeof args.text !== "string" || args.text.length === 0)
    return {
      error: fail("invalid_argument", "Pass the text to select: selectText(target, text)."),
    };
  const occurrence = args.occurrence === undefined ? undefined : natural(args.occurrence);
  const wrong =
    (args.occurrence !== undefined && occurrence === undefined) ||
    (args.prefix !== undefined && typeof args.prefix !== "string") ||
    (args.suffix !== undefined && typeof args.suffix !== "string") ||
    (args.selection !== undefined && !SELECTION.has(args.selection as string));
  if (wrong)
    return {
      error: fail(
        "invalid_argument",
        'Options are { occurrence: n >= 0, prefix, suffix, selection: "text" | "cursor_before" | "cursor_after" }.',
      ),
    };
  return {
    forwarded: {
      pid: bound.pid,
      window_id: bound.windowId,
      element_token: token,
      text: args.text,
      ...(occurrence === undefined ? {} : { occurrence }),
      ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
      ...(args.suffix === undefined ? {} : { suffix: args.suffix }),
      ...(args.selection === undefined ? {} : { selection: args.selection }),
    },
  };
};

export const makeSelectText = (deps: {
  readonly send: Send;
  readonly tokenOf: (element: Record<string, unknown>, bound: BoundWindow) => string | undefined;
}) =>
  Effect.fn("DesktopSelectionExtras.selectText")(function* (
    bound: BoundWindow,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
  ): Effect.fn.Return<ScreenHostDispatchResult, ScreenRunError> {
    const prepared = selectTextArgs(args, bound, deps.tokenOf);
    if ("error" in prepared) return yield* Effect.fail(prepared.error);
    // A selection can scroll the field, so earlier screenshot points go even if the reply is lost.
    bound.pointsStale ??= "input";
    const reply = yield* deps.send(
      "select_text",
      prepared.forwarded,
      call,
      context,
      bound.connectionGeneration,
    );
    if (toolUnavailable(reply, "select_text", prepared.forwarded))
      return yield* Effect.fail(unsupported(SELECT_TEXT_UNSUPPORTED, "write"));
    const failure = driverFailure(reply, "select_text", prepared.forwarded);
    if (failure) return yield* Effect.fail(failure);
    return driverResult("select_text", reply);
  });

export const makeMenuBarExtras = (deps: { readonly send: Send }) =>
  Effect.fn("DesktopSelectionExtras.menuBarExtras")(function* (
    call: ScreenHostCall,
    args: Record<string, unknown>,
    context: ScreenHostContext,
  ): Effect.fn.Return<ScreenHostDispatchResult, ScreenRunError> {
    const read = Effect.fn("DesktopSelectionExtras.menuBarExtras.read")(function* (
      driverArgs: Record<string, unknown>,
    ) {
      const reply = yield* deps.send("menu_bar_extras", driverArgs, call, context);
      if (toolUnavailable(reply, "menu_bar_extras", driverArgs))
        return yield* Effect.fail(unsupported(MENU_BAR_EXTRAS_UNSUPPORTED, "read"));
      const failure = driverFailure(reply, "menu_bar_extras", driverArgs);
      if (failure) return yield* Effect.fail(failure);
      return object(driverValue(reply)) ?? {};
    });
    const ownerPid = positive(args.owner_pid);
    let pid = positive(args.pid);
    if (pid === undefined) {
      pid = positive((yield* read({ operation: "system" })).system_ui_server_pid);
      if (pid === undefined)
        return yield* Effect.fail(
          fail(
            "downstream_failure",
            "The driver did not name SystemUIServer's pid; nothing was listed.",
          ),
        );
    }
    const listed = yield* read({
      operation: "list",
      pid,
      ...(ownerPid === undefined ? {} : { owner_pid: ownerPid }),
    });
    return { value: { host_pid: pid, ...listed }, category: "unverifiable" };
  });
