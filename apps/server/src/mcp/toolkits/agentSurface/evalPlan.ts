import { isKeyedWrite, listedToolName } from "@goat/contracts/agentSurface/resolve";
import type { EvalPlan, EvalResult } from "@goat/contracts/agentSurface/eval";
import * as Effect from "effect/Effect";

import type * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { availability, callerProfile, type HostConditions } from "../../toolAvailability.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";
import type { CallSite, Expr, Json, Program } from "./evalParser.ts";

/** Values that need no run: what dryRun can check against permissions and schemas. */
const constantOf = (expr: Expr): Json | undefined => {
  switch (expr.t) {
    case "lit":
      return expr.v;
    case "vec": {
      const items = expr.items.map(constantOf);
      return items.every((item) => item !== undefined) ? (items as Array<Json>) : undefined;
    }
    case "obj": {
      const entries = expr.entries.map(([key, value]) => [key, constantOf(value)] as const);
      return entries.every(([, value]) => value !== undefined)
        ? (Object.fromEntries(entries) as Json)
        : undefined;
    }
    default:
      return undefined;
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Argument names the target's schema refuses, when the program spells them out. */
const argIssues = (site: CallSite, schema: unknown): ReadonlyArray<string> => {
  if (site.keys === undefined || !isRecord(schema)) return [];
  const shape = schema as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const known = Object.keys(shape.properties ?? {});
  return [
    ...site.keys.filter((key) => !known.includes(key)).map((key) => `${key} is not an argument`),
    ...(shape.required ?? [])
      .filter((key) => key !== "clientRequestId" || !isKeyedWrite(site.entry))
      .filter((key) => !site.keys?.includes(key))
      .map((key) => `${key} is required`),
  ];
};

/**
 * dryRun: what the program would call, judged as goat_describe judges availability, plus the
 * goatclaw and host gate for calls whose arguments are known before the run. Nothing runs.
 */
export const makeEvalPlan = (
  dispatch: ToolDispatch["Service"],
  permissions: Profiles.PermissionProfiles["Service"],
  hostConditions: Effect.Effect<HostConditions>,
) =>
  Effect.fn("AgentSurface.evalPlan")(function* (program: Program) {
    const scope = yield* McpInvocationContext;
    const profile = yield* callerProfile(permissions, scope);
    const host = yield* hostConditions;
    const calls: Array<EvalPlan["calls"][number]> = [];
    for (const site of program.sites) {
      const name = listedToolName(site.entry);
      const served = dispatch.served(name);
      let available = availability(site.entry, scope, served !== undefined, profile, host);
      const args = constantOf(site.args);
      if (available.now && args !== undefined) {
        const gate = yield* McpToolAccess.requireDeclaredCapability(
          permissions,
          site.entry.name,
          site.entry.effect,
          args,
        ).pipe(Effect.result);
        if (gate._tag === "Failure") available = { now: false, reason: gate.failure.message };
      }
      calls.push({
        step: site.site,
        path: site.entry.path,
        name,
        effect: site.entry.effect,
        keyed: isKeyedWrite(site.entry),
        available,
        args: args === undefined ? "dynamic" : "static",
        argIssues: argIssues(site, served?.inputSchema),
      });
    }
    const maxCalls = program.sites.reduce((sum, site) => sum + site.times, 0);
    return { status: "ok", value: { plan: { calls, maxCalls } } } satisfies EvalResult;
  });
