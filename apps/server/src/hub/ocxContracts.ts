import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isStableOpenCodexVersion } from "./opencodexUpdatePlan.ts";

export const OCX_CONTRACT = {
  updateOrchestrated: "update.orchestrated/1",
  syncHomeFanout: "sync.home-fanout/1",
} as const;
export const CONTRACTS_ARGS = ["capabilities", "--contracts", "--json"] as const;

const Contracts = Schema.Struct({ contracts: Schema.Array(Schema.String) });
const Plan = Schema.Struct({
  schema: Schema.Literal("ocx.update.plan/1"),
  currentVersion: Schema.String,
  targetVersion: Schema.NullOr(Schema.String),
  installer: Schema.String,
  canApply: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  planToken: Schema.optional(Schema.Unknown),
  updateInFlight: Schema.optional(Schema.Unknown),
  mutationBoundMs: Schema.optional(Schema.Unknown),
  servingPath: Schema.NullOr(Schema.String),
  cliPath: Schema.String,
});
const Result = Schema.Struct({
  schema: Schema.Literal("ocx.update.result/1"),
  applied: Schema.Boolean,
  toVersion: Schema.NullOr(Schema.String),
  healthy: Schema.Boolean,
  rolledBack: Schema.Boolean,
});
const decodeContracts = Schema.decodeUnknownOption(Schema.fromJsonString(Contracts));
const decodePlan = Schema.decodeUnknownOption(Schema.fromJsonString(Plan));
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result));
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;

export const probeContracts = (
  output:
    | { readonly code: number | null; readonly stdout: string; readonly timedOut?: boolean }
    | undefined,
):
  | { readonly kind: "known"; readonly contracts: ReadonlySet<string> }
  | { readonly kind: "unknown" } => {
  if (output === undefined || output.timedOut) return { kind: "unknown" };
  if (output.code === 64) return { kind: "known", contracts: new Set() };
  if (output.code !== 0) return { kind: "unknown" };
  const parsed = decodeContracts(output.stdout);
  return Option.isSome(parsed)
    ? { kind: "known", contracts: new Set(parsed.value.contracts) }
    : { kind: "unknown" };
};

export interface OrchestratedPlan {
  readonly canApply: boolean;
  readonly currentVersion: string;
  readonly targetVersion: string | null;
  readonly reason?: string;
  readonly planToken: string;
  readonly updateInFlight: boolean;
  readonly mutationBoundMs: number;
  readonly servingPath: string | null;
  readonly cliPath: string;
}

export const orchestratedPlanOf = (
  stdout: string,
):
  | { readonly kind: "plan"; readonly plan: OrchestratedPlan }
  | { readonly kind: "legacy" | "unknown" } => {
  const parsed = decodePlan(stdout);
  if (Option.isNone(parsed)) return { kind: "unknown" };
  const { planToken, updateInFlight, mutationBoundMs, reason, ...plan } = parsed.value;
  if (
    typeof planToken !== "string" ||
    !TOKEN.test(planToken) ||
    typeof updateInFlight !== "boolean" ||
    typeof mutationBoundMs !== "number" ||
    !Number.isFinite(mutationBoundMs) ||
    mutationBoundMs <= 0
  )
    return { kind: "legacy" };
  return {
    kind: "plan",
    plan: {
      ...plan,
      ...(reason === undefined ? {} : { reason }),
      planToken,
      updateInFlight,
      mutationBoundMs,
    },
  };
};

export const applyOutcome = (
  code: number | null,
  timedOut: boolean | undefined,
  stdout: string,
  requested: string,
): "applied" | "refused" | "rolled-back" | "uncertain" => {
  if (timedOut) return "uncertain";
  if (code === 10) return "refused";
  if (code === 11) return "rolled-back";
  if (code !== 0) return "uncertain";
  const result = decodeResult(stdout);
  return Option.isSome(result) &&
    result.value.toVersion === requested &&
    result.value.healthy &&
    !result.value.rolledBack
    ? "applied"
    : "uncertain";
};

const stable = (version: string) => {
  if (!isStableOpenCodexVersion(version)) throw new TypeError("Unsafe OpenCodex version.");
  return version;
};
export const planArgs = (version: string) => [
  "update",
  "--plan",
  "--json",
  "--version",
  stable(version),
];
export const applyArgs = (version: string, token: string, notAfter: number) => {
  if (!TOKEN.test(token) || !Number.isSafeInteger(notAfter) || notAfter < 0)
    throw new TypeError("Unsafe OpenCodex update fence.");
  return [
    "update",
    "--yes",
    "--json",
    "--version",
    stable(version),
    "--expect-plan",
    token,
    "--not-after",
    String(notAfter),
  ];
};
