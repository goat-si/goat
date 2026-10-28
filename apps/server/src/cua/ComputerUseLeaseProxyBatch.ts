// @effect-diagnostics preferSchemaOverJson:off -- The provider's JSON-RPC line keeps its opaque fields.
/**
 * Under an app list the proxy gives an unscoped run_steps or run_script the control's approved
 * apps as its `app_scope` (ComputerUseScope then admits it). A driver whose tool list lacks
 * `app_scope` could ignore one and run the batch unscoped, so a scope never goes to it.
 */
import * as Effect from "effect/Effect";

import { isBatchTool, MAX_BATCH_SCOPE_APPS } from "./ComputerUseBatchScope.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import { type JsonRpcId, refusal } from "./ComputerUseLeaseResponses.ts";

export const BATCH_SCOPE_UNSUPPORTED =
  "This version of GOAT Computer Use cannot keep run_steps or run_script to the apps in app_scope, so the call did not run. Make the calls one at a time, each with the pid and window_id of an approved app's window.";

type Send = (line: string) => Effect.Effect<void>;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Whether a tools/list result gives the tool an `app_scope` input. */
const acceptsAppScope = (toolList: unknown, name: string): boolean => {
  const listed = record(toolList)?.tools;
  if (!Array.isArray(listed)) return false;
  const tool = listed.map(record).find((entry) => entry?.name === name);
  return record(record(record(tool?.inputSchema)?.properties)?.app_scope) !== undefined;
};

/**
 * A proxy's scoping of batch calls.
 *
 * @param tools The driver's tools/list result; given a send, the child is asked when none is known.
 * @param grantApps The apps the control's grant names, as it spells them; undefined for the whole
 *   screen.
 */
export const makeProxyBatchScope = (
  tools: (send: Send | undefined) => Effect.Effect<unknown>,
  grantApps: () => ReadonlyArray<string> | undefined,
) =>
  /** The call as the driver should get it, or the proxy's refusal (notSent while it has no child). */
  Effect.fn("ComputerUseLeaseProxy.scopeBatch")(function* (
    id: JsonRpcId,
    line: string,
    message: Envelope,
    current: Running | undefined,
    notSent: () => string,
  ) {
    const unchanged = { line, message };
    const name = message.params?.name;
    if (!isBatchTool(name)) return unchanged;
    const args = record(message.params?.arguments) ?? {};
    const named = args.app_scope !== undefined && args.app_scope !== null;
    const apps = grantApps();
    // Without a list the batch may act anywhere; past the driver's limit it stays refused.
    if (!named && (apps === undefined || apps.length > MAX_BATCH_SCOPE_APPS)) return unchanged;
    // Without a child nothing can be sent; a scope must not reach one that was never asked.
    if (current === undefined) return named ? { refused: notSent() } : unchanged;
    // Only a batch that names a scope waits for the child's tool list; one GOAT would scope gets
    // the scope once the driver is known to keep it, and is refused as before until then.
    if (!acceptsAppScope(yield* tools(named ? current.driver.send : undefined), name))
      return named
        ? { refused: refusal(id, message.method, "outside_manifest", BATCH_SCOPE_UNSUPPORTED) }
        : unchanged;
    if (named || apps === undefined) return unchanged;
    const appScope = { apps, delivery: "background" };
    const raw = record(JSON.parse(line)) ?? {};
    const params = record(raw.params) ?? {};
    const rawArgs = record(params.arguments) ?? {};
    return {
      line: JSON.stringify({
        ...raw,
        params: { ...params, arguments: { ...rawArgs, app_scope: appScope } },
      }),
      message: {
        ...message,
        params: { ...message.params, arguments: { ...args, app_scope: appScope } },
      } as Envelope,
    };
  });
