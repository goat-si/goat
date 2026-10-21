import {
  OrchestratorMcpFailure,
  type HubDeviceOperationInput,
  type HubDeviceOperationResult,
  type HubDeviceStep,
  type HubParityCheckId,
  type HubParityResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as HubParity from "./HubParity.ts";
import { HubOcx, HubOcxError, SAFE_ALIAS, type OcxOutput } from "./HubOcx.ts";

const DECISION_TTL_MS = 24 * 60 * 60 * 1000;
// OpenCodex's own enrollment deadline is 360 seconds; leave room for its cleanup.
const LINK_ADD_TIMEOUT_MS = 420_000;
const HOME_TIMEOUT_MS = 60_000;
const DEVICE_TIMEOUT_MS = 120_000;

const LinkStatus = Schema.Struct({
  role: Schema.Literals(["standalone", "home", "child"]),
  links: Schema.Array(Schema.Struct({ id: Schema.String, alias: Schema.String })),
});
const Probe = Schema.Struct({
  alias: Schema.String,
  fingerprint: Schema.String,
  keyType: Schema.String,
});
const Added = Schema.Struct({ linkId: Schema.String });
const decodeJson = <A, I>(schema: Schema.Codec<A, I>, text: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text.trim()));

type Action = HubDeviceOperationResult["action"];
type Rung = "sync" | "restart" | "reconnect";
/** Ladder order and the checks each rung addresses (§1.4). */
const LADDER: ReadonlyArray<{
  readonly step: Rung;
  readonly checks: ReadonlyArray<HubParityCheckId>;
}> = [
  { step: "sync", checks: ["P6", "P7"] },
  { step: "restart", checks: ["P5"] },
  { step: "reconnect", checks: ["P2", "P3"] },
];

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The hub audit log is unavailable.",
  });
const actorOf = (scope: McpInvocationScope) =>
  scope.thread === undefined
    ? `mcp:${scope.client?.sessionId ?? scope.requestNamespace}`
    : `thread:${scope.thread.threadId}`;
/** The decision context carries this line; an approval only counts for the same action and key. */
export const decisionBinding = (action: "join" | "leave" | "relink", alias: string, key?: string) =>
  `goat-hub-binding: ${action} ${alias}${key === undefined ? "" : ` ${key}`}`;
const phaseMessage = (phase: string | undefined) =>
  phase === "remote_platform_unsupported"
    ? "Remote Link refuses this platform; it joins as a Hub-mode client instead."
    : phase === undefined
      ? "OpenCodex refused the command."
      : `OpenCodex stopped at ${phase}.`;

export class HubMembership extends Context.Service<
  HubMembership,
  {
    readonly join: (
      scope: McpInvocationScope,
      input: HubDeviceOperationInput,
    ) => Effect.Effect<HubDeviceOperationResult, OrchestratorMcpFailure>;
    readonly leave: (
      scope: McpInvocationScope,
      input: HubDeviceOperationInput,
    ) => Effect.Effect<HubDeviceOperationResult, OrchestratorMcpFailure>;
    readonly repair: (
      scope: McpInvocationScope,
      input: HubDeviceOperationInput,
    ) => Effect.Effect<HubDeviceOperationResult, OrchestratorMcpFailure>;
  }
>()("goat/hub/HubMembership") {}

const make = Effect.gen(function* () {
  const ocx = yield* HubOcx;
  const parity = yield* HubParity.HubParity;
  const inbox = yield* DecisionInbox.DecisionInbox;
  const profiles = yield* Profiles.PermissionProfiles;
  const sql = yield* SqlClient.SqlClient;
  // One hub, one link store: membership changes never interleave.
  const permit = yield* Semaphore.make(1);

  const audit = Effect.fn("HubMembership.audit")(function* (
    caller: { readonly actor: string; readonly profile: string },
    action: string,
    target: string,
    outcome: string,
    decisionId: string | undefined,
  ) {
    const time = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
      VALUES (${time}, ${caller.actor}, ${caller.profile}, ${action}, ${target}, ${outcome}, ${decisionId ?? null})`;
  }, Effect.mapError(storageFailure));

  const authorize = Effect.fn("HubMembership.authorize")(function* (
    scope: McpInvocationScope,
    alias: string,
  ) {
    if (!SAFE_ALIAS.test(alias)) return yield* invalid("deviceAlias must be a plain SSH alias.");
    const view = yield* profiles.require(scope, "hub.manage", { host: alias });
    return {
      actor: actorOf(scope),
      profile: view.profile.id,
      // Disabled goatclaw resolves to the default profile, so it never counts as owner.
      owner: view.enabled && view.profile.id === "owner",
    };
  });

  const homeLinks = Effect.fn("HubMembership.homeLinks")(function* () {
    const output = yield* ocx.home(["link", "status", "--json"], HOME_TIMEOUT_MS);
    return output.code === 0 ? decodeJson(LinkStatus, output.stdout) : undefined;
  });

  const probe = Effect.fn("HubMembership.probe")(function* (alias: string) {
    const output = yield* ocx.home(["link", "probe", alias, "--json"], HOME_TIMEOUT_MS);
    const offered = output.code === 0 ? decodeJson(Probe, output.stdout) : undefined;
    return offered?.alias === alias
      ? { ok: true as const, ...offered }
      : { ok: false as const, phase: output.phase };
  });

  const approved = Effect.fn("HubMembership.approved")(function* (
    scope: McpInvocationScope,
    decisionId: string,
    binding: string,
  ) {
    const item = yield* inbox.get({ kind: "agent", scope }, decisionId);
    // requiredProfile owner means only a person or an owner agent could have answered it.
    if (
      item.source !== "decision" ||
      item.requiredProfile !== "owner" ||
      !item.context.split("\n").includes(binding)
    )
      return yield* invalid(
        "That decision does not approve this change for this device and host key. Call again without decisionId to request a new one.",
      );
    if (item.status === "open")
      return yield* invalid("That decision is still open; call again once it is answered.");
    if (item.status !== "answered" || item.answer !== "approve")
      return yield* invalid("That decision was not approved.");
    const used = yield* sql<{
      id: number;
    }>`SELECT id FROM audit_events WHERE decision_id = ${decisionId} AND action LIKE 'hub.%' AND outcome = 'started' LIMIT 1`.pipe(
      Effect.mapError(storageFailure),
    );
    if (used.length > 0) return yield* invalid("That decision was already used.");
  });

  const requestDecision = Effect.fn("HubMembership.requestDecision")(function* (
    scope: McpInvocationScope,
    input: {
      readonly title: string;
      readonly context: string;
      readonly binding: string;
      readonly approve: string;
      readonly consequence: string;
    },
  ) {
    const expiresAt = DateTime.formatIso(
      DateTime.add(yield* DateTime.now, { milliseconds: DECISION_TTL_MS }),
    );
    const item = yield* inbox.create(
      { kind: "agent", scope },
      {
        title: input.title,
        context: `${input.context}\n\n${input.binding}`,
        options: [
          { id: "approve", label: input.approve, consequence: input.consequence },
          { id: "decline", label: "Decline", consequence: "Nothing changes." },
        ],
        requiredProfile: "owner",
        expiresAt,
      },
    );
    return item.id;
  });

  const failing = (result: HubParityResult) => result.failingCheckIds.length > 0;
  const finalState = (result: HubParityResult): HubDeviceOperationResult["state"] =>
    !failing(result) ? "child" : result.verdict === "broken" ? "failed" : "degraded";
  const unreachable = (error: HubOcxError) => ({
    outcome: "failed" as const,
    detail: error.message,
  });

  /** Steps 1-3. Each executed rung re-runs the verdict; stops as soon as nothing fails. */
  const ladder = Effect.fn("HubMembership.ladder")(function* (
    scope: McpInvocationScope,
    caller: { readonly actor: string; readonly profile: string },
    alias: string,
    linkId: string | undefined,
    initial: HubParityResult,
    steps: HubDeviceStep[],
  ) {
    let current = initial;
    for (const rung of LADDER) {
      if (!failing(current)) break;
      if (!rung.checks.some((id) => current.failingCheckIds.includes(id))) continue;
      let ran: Pick<HubDeviceStep, "outcome" | "detail">;
      if (rung.step === "reconnect") {
        if (linkId === undefined) continue;
        ran = yield* ocx
          .home(["link", "reconnect", "--link-id", linkId, "--json"], HOME_TIMEOUT_MS)
          .pipe(
            Effect.map((output: OcxOutput) =>
              output.code === 0
                ? { outcome: "ok" as const }
                : { outcome: "failed" as const, detail: phaseMessage(output.phase) },
            ),
            Effect.catch((error) => Effect.succeed(unreachable(error))),
          );
      } else if (rung.step === "restart" && (yield* ocx.runningTurns(alias, scope)) !== 0) {
        // ADR-0019's idle rule: never restart under a running turn, and unknown is not idle.
        ran = {
          outcome: "deferred",
          detail: "A turn is running there, or its activity is unknown.",
        };
      } else {
        ran = yield* ocx.device(alias, [rung.step], DEVICE_TIMEOUT_MS).pipe(
          Effect.map((output: OcxOutput) =>
            output.code === 0
              ? { outcome: "ok" as const }
              : { outcome: "failed" as const, detail: `ocx ${rung.step} exited ${output.code}.` },
          ),
          Effect.catch((error) => Effect.succeed(unreachable(error))),
        );
      }
      steps.push({ step: rung.step, ...ran });
      yield* audit(caller, `hub.repair.${rung.step}`, alias, ran.outcome, undefined);
      if (ran.outcome !== "deferred") current = yield* parity.verify(alias, scope);
    }
    return current;
  });

  const result = (
    action: Action,
    alias: string,
    state: HubDeviceOperationResult["state"],
    message: string,
    steps: ReadonlyArray<HubDeviceStep>,
    extra: { readonly parity?: HubParityResult; readonly decisionId?: string } = {},
  ): HubDeviceOperationResult => ({
    deviceAlias: alias,
    action,
    state,
    message,
    steps,
    ...extra,
  });

  /** Link add, verification and steps 1-3: the shared tail of join and re-link. */
  const link = Effect.fn("HubMembership.link")(function* (
    scope: McpInvocationScope,
    caller: { readonly actor: string; readonly profile: string },
    action: Action,
    alias: string,
    fingerprint: string,
    decisionId: string | undefined,
    steps: HubDeviceStep[],
  ) {
    const added = yield* ocx.home(
      ["link", "add", alias, "--expect-fingerprint", fingerprint, "--json"],
      LINK_ADD_TIMEOUT_MS,
    );
    const linkId = added.code === 0 ? decodeJson(Added, added.stdout)?.linkId : undefined;
    if (linkId === undefined) {
      steps.push({ step: "link_add", outcome: "failed", detail: phaseMessage(added.phase) });
      yield* audit(caller, `hub.${action}`, alias, "failed", decisionId);
      return result(action, alias, "failed", phaseMessage(added.phase), steps);
    }
    steps.push({ step: "link_add", outcome: "ok", detail: linkId });
    const verified = yield* ladder(
      scope,
      caller,
      alias,
      linkId,
      yield* parity.verify(alias, scope),
      steps,
    );
    const state = finalState(verified);
    yield* audit(caller, `hub.${action}`, alias, state, decisionId);
    return result(
      action,
      alias,
      state,
      state === "child"
        ? `${alias} is linked to this Home.`
        : `${alias} is linked, but ${verified.failingCheckIds.join(", ")} still fail.`,
      steps,
      { parity: verified },
    );
  });

  /** Revoke on the Home, then disconnect the device. */
  const unlink = Effect.fn("HubMembership.unlink")(function* (
    alias: string,
    linkId: string,
    steps: HubDeviceStep[],
  ) {
    const revoked = yield* ocx.home(
      ["link", "revoke", "--link-id", linkId, "--json"],
      HOME_TIMEOUT_MS,
    );
    if (revoked.code !== 0 && revoked.phase !== "link_not_found") {
      steps.push({ step: "revoke", outcome: "failed", detail: phaseMessage(revoked.phase) });
      return false;
    }
    steps.push({ step: "revoke", outcome: "ok", detail: linkId });
    const disconnected = yield* ocx.device(alias, ["disconnect", "--json"], DEVICE_TIMEOUT_MS).pipe(
      Effect.map((output: OcxOutput) =>
        output.code === 0
          ? { outcome: "ok" as const }
          : { outcome: "failed" as const, detail: `ocx disconnect exited ${output.code}.` },
      ),
      Effect.catch((error) => Effect.succeed(unreachable(error))),
    );
    steps.push({ step: "disconnect", ...disconnected });
    return disconnected.outcome === "ok";
  });

  const homeUnavailable = (action: Action, alias: string, steps: ReadonlyArray<HubDeviceStep>) =>
    result(action, alias, "failed", "This machine's OpenCodex link status is unavailable.", steps);

  const join = Effect.fn("HubMembership.join")(function* (
    scope: McpInvocationScope,
    input: HubDeviceOperationInput,
  ) {
    const alias = input.deviceAlias;
    const caller = yield* authorize(scope, alias);
    const steps: HubDeviceStep[] = [];
    return yield* Effect.gen(function* () {
      if (!(yield* ocx.directAlias(alias)))
        return result(
          "join",
          alias,
          "failed",
          `${alias} does not resolve to a direct SSH host. Use a direct Tailscale alias without ProxyJump or ProxyCommand.`,
          steps,
        );
      const status = yield* homeLinks();
      if (status === undefined) return homeUnavailable("join", alias, steps);
      if (status.role === "child")
        return result(
          "join",
          alias,
          "failed",
          "This machine is a Child and cannot be a Home.",
          steps,
        );
      if (status.links.some((entry) => entry.alias === alias)) {
        const verified = yield* parity.verify(alias, scope);
        return result(
          "join",
          alias,
          finalState(verified),
          `${alias} is already linked; nothing was changed. Use goat_hub_device_repair if checks fail.`,
          steps,
          { parity: verified },
        );
      }
      // Ready means OpenCodex answers on the device; installing it is a separate, consented step.
      yield* ocx.device(alias, ["--version"], DEVICE_TIMEOUT_MS);
      const offered = yield* probe(alias);
      if (!offered.ok) {
        steps.push({ step: "probe", outcome: "failed", detail: phaseMessage(offered.phase) });
        return result("join", alias, "failed", phaseMessage(offered.phase), steps);
      }
      steps.push({
        step: "probe",
        outcome: "ok",
        detail: `${offered.keyType} ${offered.fingerprint}`,
      });
      const pin = yield* ocx.pinnedFingerprint(alias);
      const binding = decisionBinding("join", alias, offered.fingerprint);
      if (input.decisionId !== undefined) yield* approved(scope, input.decisionId, binding);
      else if (pin !== offered.fingerprint || !caller.owner) {
        const reason =
          pin === undefined
            ? "GOAT has no pinned host key for this alias."
            : pin !== offered.fingerprint
              ? `GOAT's pinned key is ${pin}, which differs from the offered key.`
              : "Joining a device needs an owner's approval.";
        const decisionId = yield* requestDecision(scope, {
          title: `Join ${alias} to the hub`,
          context: `OpenCodex offers ${offered.keyType} ${offered.fingerprint} for ${alias}. ${reason} Approving links ${alias} as a Remote Link Child; its model traffic then goes through this Home.`,
          binding,
          approve: "Join with this key",
          consequence: `${alias} routes through this Home.`,
        });
        yield* audit(caller, "hub.join", alias, "needs_decision", decisionId);
        return result("join", alias, "needs_human", reason, steps, { decisionId });
      }
      yield* audit(caller, "hub.join", alias, "started", input.decisionId);
      return yield* link(
        scope,
        caller,
        "join",
        alias,
        offered.fingerprint,
        input.decisionId,
        steps,
      );
    }).pipe(
      Effect.catchTags({
        HubOcxError: (error) =>
          Effect.succeed(result("join", alias, "failed", error.message, steps)),
      }),
    );
  });

  const leave = Effect.fn("HubMembership.leave")(function* (
    scope: McpInvocationScope,
    input: HubDeviceOperationInput,
  ) {
    const alias = input.deviceAlias;
    const caller = yield* authorize(scope, alias);
    const steps: HubDeviceStep[] = [];
    return yield* Effect.gen(function* () {
      const status = yield* homeLinks();
      if (status === undefined) return homeUnavailable("leave", alias, steps);
      const record = status.links.find((entry) => entry.alias === alias);
      if (record === undefined)
        return result("leave", alias, "ready", `${alias} is not linked to this Home.`, steps);
      const binding = decisionBinding("leave", alias, record.id);
      if (input.decisionId !== undefined) yield* approved(scope, input.decisionId, binding);
      else if (!caller.owner) {
        const decisionId = yield* requestDecision(scope, {
          title: `Remove ${alias} from the hub`,
          context: `Revokes link ${record.id} on this Home and disconnects ${alias}, which returns to its own OpenCodex settings.`,
          binding,
          approve: "Remove it",
          consequence: `${alias} stops routing through this Home.`,
        });
        yield* audit(caller, "hub.leave", alias, "needs_decision", decisionId);
        return result(
          "leave",
          alias,
          "needs_human",
          "Removing a device needs an owner's approval.",
          steps,
          {
            decisionId,
          },
        );
      }
      yield* audit(caller, "hub.leave", alias, "started", input.decisionId);
      const clean = yield* unlink(alias, record.id, steps);
      const revoked = steps.some(({ step, outcome }) => step === "revoke" && outcome === "ok");
      const state = clean ? "ready" : revoked ? "degraded" : "failed";
      yield* audit(caller, "hub.leave", alias, state, input.decisionId);
      return result(
        "leave",
        alias,
        state,
        clean
          ? `${alias} left the hub.`
          : revoked
            ? `The Home revoked the link; run ocx disconnect on ${alias} to finish.`
            : "The Home did not revoke the link.",
        steps,
      );
    }).pipe(
      Effect.catchTags({
        HubOcxError: (error) =>
          Effect.succeed(result("leave", alias, "failed", error.message, steps)),
      }),
    );
  });

  const repair = Effect.fn("HubMembership.repair")(function* (
    scope: McpInvocationScope,
    input: HubDeviceOperationInput,
  ) {
    const alias = input.deviceAlias;
    const caller = yield* authorize(scope, alias);
    const steps: HubDeviceStep[] = [];
    return yield* Effect.gen(function* () {
      const status = yield* homeLinks();
      if (status === undefined) return homeUnavailable("repair", alias, steps);
      const record = status.links.find((entry) => entry.alias === alias);
      if (input.decisionId !== undefined) {
        // Step 4, re-link, only after a person approved it for the same host key.
        if (record === undefined) return yield* invalid(`${alias} has no link to re-create.`);
        const offered = yield* probe(alias);
        if (!offered.ok) {
          steps.push({ step: "probe", outcome: "failed", detail: phaseMessage(offered.phase) });
          return result("repair", alias, "failed", phaseMessage(offered.phase), steps);
        }
        steps.push({
          step: "probe",
          outcome: "ok",
          detail: `${offered.keyType} ${offered.fingerprint}`,
        });
        yield* approved(
          scope,
          input.decisionId,
          decisionBinding("relink", alias, offered.fingerprint),
        );
        yield* audit(caller, "hub.relink", alias, "started", input.decisionId);
        const clean = yield* unlink(alias, record.id, steps);
        if (!clean) {
          yield* audit(caller, "hub.relink", alias, "failed", input.decisionId);
          return result(
            "repair",
            alias,
            "failed",
            "Re-link stopped before linking again; the device may need ocx disconnect.",
            steps,
          );
        }
        return yield* link(
          scope,
          caller,
          "repair",
          alias,
          offered.fingerprint,
          input.decisionId,
          steps,
        );
      }
      const initial = yield* parity.verify(alias, scope);
      if (!failing(initial))
        return result(
          "repair",
          alias,
          "child",
          "No parity check fails; nothing to repair.",
          steps,
          {
            parity: initial,
          },
        );
      const repaired = yield* ladder(scope, caller, alias, record?.id, initial, steps);
      if (!failing(repaired)) {
        yield* audit(caller, "hub.repair", alias, "child", undefined);
        return result("repair", alias, "child", `${alias} is repaired.`, steps, {
          parity: repaired,
        });
      }
      const exhausted = `Steps 1-3 left ${repaired.failingCheckIds.join(", ")} failing.`;
      if (record === undefined || steps.some(({ outcome }) => outcome === "deferred")) {
        yield* audit(caller, "hub.repair", alias, finalState(repaired), undefined);
        return result(
          "repair",
          alias,
          finalState(repaired),
          record === undefined
            ? `${exhausted} ${alias} has no Remote Link record to re-create.`
            : `${exhausted} A deferred restart can run once the device is idle.`,
          steps,
          { parity: repaired },
        );
      }
      const offered = yield* probe(alias);
      if (!offered.ok) {
        steps.push({ step: "probe", outcome: "failed", detail: phaseMessage(offered.phase) });
        yield* audit(caller, "hub.repair", alias, "failed", undefined);
        return result("repair", alias, "failed", exhausted, steps, { parity: repaired });
      }
      const decisionId = yield* requestDecision(scope, {
        title: `Re-link ${alias}`,
        context: `${exhausted} Re-linking revokes link ${record.id}, disconnects ${alias} and joins it again with ${offered.keyType} ${offered.fingerprint}; routing is briefly gone.`,
        binding: decisionBinding("relink", alias, offered.fingerprint),
        approve: "Re-link",
        consequence: `${alias} loses routing until the new link is verified.`,
      });
      yield* audit(caller, "hub.repair", alias, "needs_decision", decisionId);
      return result("repair", alias, "needs_human", exhausted, steps, {
        parity: repaired,
        decisionId,
      });
    }).pipe(
      Effect.catchTags({
        HubOcxError: (error) =>
          Effect.succeed(result("repair", alias, "failed", error.message, steps)),
      }),
    );
  });

  return HubMembership.of({
    join: (scope, input) => permit.withPermits(1)(join(scope, input)),
    leave: (scope, input) => permit.withPermits(1)(leave(scope, input)),
    repair: (scope, input) => permit.withPermits(1)(repair(scope, input)),
  });
});

export const layer = Layer.effect(HubMembership, make);
