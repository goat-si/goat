// @effect-diagnostics preferSchemaOverJson:off -- The provider's JSON-RPC line keeps its opaque fields.
/**
 * run_steps and run_script under a lease proxy. The driver (goat.6+) keeps a batch with an
 * `app_scope` to those apps' windows, refusing each call outside them with nothing sent, so the
 * proxy admits such a batch under an app list (ComputerUseScope) and gives one without a scope the
 * control's approved apps. A driver whose tool list has no `app_scope` could ignore it and run the
 * batch unscoped, so a batch that names one is refused there and one without keeps today's refusal.
 *
 * @module ComputerUseLeaseProxyBatch
 */
import * as Effect from "effect/Effect";

import { isBatchTool, MAX_BATCH_SCOPE_APPS } from "./ComputerUseBatchScope.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import { type JsonRpcId, refusal } from "./ComputerUseLeaseResponses.ts";

export const BATCH_SCOPE_UNSUPPORTED =
  "This version of GOAT Computer Use cannot keep run_steps or run_script to the apps in app_scope, so the call did not run. Make the calls one at a time, each with the pid and window_id of an approved app's window.";

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Whether a tools/list result gives the tool an `app_scope` input. */
export const acceptsAppScope = (toolList: unknown, name: string): boolean => {
  const listed = record(toolList)?.tools;
  if (!Array.isArray(listed)) return false;
  const tool = listed.map(record).find((entry) => entry?.name === name);
  return record(record(record(tool?.inputSchema)?.properties)?.app_scope) !== undefined;
};

/** The call as the driver should get it, or the proxy's refusal. */
export const scopeProxyBatch = Effect.fn("ComputerUseLeaseProxy.scopeBatch")(function* (input: {
  readonly id: JsonRpcId;
  readonly line: string;
  readonly message: Envelope;
  /** The apps the control's grant names, as it spells them; undefined for the whole screen. */
  readonly grantApps: ReadonlyArray<string> | undefined;
  /** The current child's send, or undefined while the proxy has none (paused or ended). */
  readonly send: ((line: string) => Effect.Effect<void>) | undefined;
  /** The driver's tools/list result; with a send, the child is asked when none is known yet. */
  readonly tools: (
    send: ((line: string) => Effect.Effect<void>) | undefined,
  ) => Effect.Effect<unknown>;
  /** The proxy's answer for a call that cannot be sent now. */
  readonly notSent: () => string;
}) {
  const unchanged = { line: input.line, message: input.message };
  const name = input.message.params?.name;
  if (!isBatchTool(name)) return unchanged;
  const args = record(input.message.params?.arguments) ?? {};
  const named = args.app_scope !== undefined && args.app_scope !== null;
  const grantApps = input.grantApps;
  // Without a list the batch may act anywhere; past the driver's limit it stays refused.
  if (!named && (grantApps === undefined || grantApps.length > MAX_BATCH_SCOPE_APPS))
    return unchanged;
  // Without a child nothing can be sent; a scope must not reach one that was never asked.
  if (input.send === undefined) return named ? { refused: input.notSent() } : unchanged;
  // Only a batch that names a scope waits for the child's tool list; one GOAT would scope gets
  // the scope only once the driver is known to keep it, and is refused as before until then.
  if (!acceptsAppScope(yield* input.tools(named ? input.send : undefined), name))
    return named
      ? {
          refused: refusal(
            input.id,
            input.message.method,
            "outside_manifest",
            BATCH_SCOPE_UNSUPPORTED,
          ),
        }
      : unchanged;
  if (named || grantApps === undefined) return unchanged;
  const appScope = { apps: grantApps, delivery: "background" };
  const scoped = { ...args, app_scope: appScope } as NonNullable<Envelope["params"]>["arguments"];
  const raw = record(JSON.parse(input.line)) ?? {};
  const params = record(raw.params) ?? {};
  const rawArgs = record(params.arguments) ?? {};
  return {
    line: JSON.stringify({
      ...raw,
      params: { ...params, arguments: { ...rawArgs, app_scope: appScope } },
    }),
    message: {
      ...input.message,
      params: { ...input.message.params, arguments: scoped },
    } as Envelope,
  };
});
