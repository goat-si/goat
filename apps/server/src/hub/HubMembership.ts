import {
  type AuthEnvironmentScope,
  OrchestratorMcpFailure,
  type HandoffSummary,
  type HubDeviceMcpResult,
  type HubDeviceOperationInput,
  type HubDeviceOperationResult,
  type HubDeviceStep,
  type HubDeviceTransport,
  type HubParityCheckId,
  type HubParityResult,
  hasCloudMachineAliasPrefix,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as ApprovalHandoffs from "../handoffs/ApprovalHandoffs.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { makeHubConsent } from "./HubConsent.ts";
import { Added, Connection, decodeJson, Health, LinkStatus, Probe } from "./hubOcxJson.ts";
import * as HubParity from "./HubParity.ts";
import { HubOcx, HubOcxError, SAFE_ALIAS, type OcxOutput } from "./HubOcx.ts";
import { makeProvisionedLinks, type ProvisionedLinkReleases } from "./HubProvisionedLinks.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

// OpenCodex's own enrollment deadline is 360 seconds; leave room for its cleanup.
const LINK_ADD_TIMEOUT_MS = 420_000;
// `ocx connect` exchanges the code, then waits up to 120 idle seconds for the catalog.
const CONNECT_TIMEOUT_MS = 300_000;
const HOME_TIMEOUT_MS = 60_000;
const DEVICE_TIMEOUT_MS = 120_000;
const WINDOWS_REFUSAL =
  "Remote Link refuses Windows (remote_platform_unsupported); join it as a Hub-mode client with transport hub-client.";
const PLATFORM_LABEL = { windows: "Windows", posix: "POSIX", unknown: "Platform unknown" };

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
/**
 * A person in a GOAT client. Only the authenticated WebSocket boundary builds it, from a session
 * holding settings:write (the decision inbox's owner rule); tool input can never produce one.
 */
export interface HubPerson {
  readonly sessionId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}
interface Caller {
  readonly actor: string;
  readonly profile: string;
  readonly owner: boolean;
  readonly inbox: DecisionInbox.DecisionCaller;
  /** GOAT itself, for a machine it created; its link is recorded so a removal releases it. */
  readonly provisioning?: true;
  /** Nobody is asked: only GOAT's pinned key links, and a mismatch fails. */
  readonly pinnedOnly?: true;
  /** Standing permission for such a join, read under the permit and right before `ocx link add`. */
  readonly gate?: Effect.Effect<boolean, OrchestratorMcpFailure>;
}
/** What the Home holds for a member: a Remote Link record, or a Hub client's data key id. */
type Member =
  | { readonly kind: "remote-link"; readonly id: string; readonly tunnelPort?: number | undefined }
  | { readonly kind: "hub-client"; readonly id: string };
/** The decision context carries this line; an approval only counts for the same action and key. */
export const decisionBinding = (
  action: "join" | "leave" | "leave-force" | "relink",
  alias: string,
  key?: string,
) => `goat-hub-binding: ${action} ${alias}${key === undefined ? "" : ` ${key}`}`;
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
      person?: HubPerson,
    ) => Effect.Effect<HubDeviceMcpResult, OrchestratorMcpFailure>;
    readonly leave: (
      scope: McpInvocationScope,
      input: HubDeviceOperationInput,
      person?: HubPerson,
    ) => Effect.Effect<HubDeviceMcpResult, OrchestratorMcpFailure>;
    readonly repair: (
      scope: McpInvocationScope,
      input: HubDeviceOperationInput,
      person?: HubPerson,
    ) => Effect.Effect<HubDeviceMcpResult, OrchestratorMcpFailure>;
    /**
     * Joins a cloud machine GOAT created as a Remote Link Child, with no person to ask. It links
     * only when OpenCodex offers exactly the host key GOAT pinned from the provider's API, and
     * fails otherwise; the hub being enabled is the owner's standing choice.
     */
    readonly joinProvisioned: (
      scope: McpInvocationScope,
      alias: string,
      gate: Effect.Effect<boolean, OrchestratorMcpFailure>,
    ) => Effect.Effect<HubDeviceMcpResult, OrchestratorMcpFailure>;
    /**
     * Joins an SSH host on a person's standing consent, with nobody asked now. `consent` yields
     * that person while the consent holds and undefined once it is withdrawn; like a provisioning
     * join, only GOAT's pinned key links. Cloud machines join only through joinProvisioned.
     */
    readonly joinWithConsent: (
      scope: McpInvocationScope,
      alias: string,
      consent: Effect.Effect<HubPerson | undefined, OrchestratorMcpFailure>,
    ) => Effect.Effect<HubDeviceMcpResult, OrchestratorMcpFailure>;
  } & ProvisionedLinkReleases
>()("goat/hub/HubMembership") {}

const make = Effect.gen(function* () {
  const ocx = yield* HubOcx;
  const parity = yield* HubParity.HubParity;
  const consent = yield* makeHubConsent;
  const profiles = yield* Profiles.PermissionProfiles;
  const sql = yield* SqlClient.SqlClient;
  const provisioned = yield* makeProvisionedLinks;
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

  // A person acts with their own authority; profiles narrow agents, not people.
  const personCaller = (scope: McpInvocationScope, person: HubPerson): Caller => ({
    actor: `client:${person.sessionId}`,
    profile: "person",
    owner: true,
    inbox: {
      kind: "client",
      environmentId: scope.environmentId,
      sessionId: person.sessionId,
      scopes: person.scopes,
    },
  });
  const authorize = Effect.fn("HubMembership.authorize")(function* (
    scope: McpInvocationScope,
    alias: string,
    person: HubPerson | undefined,
  ) {
    if (!SAFE_ALIAS.test(alias)) return yield* invalid("deviceAlias must be a plain SSH alias.");
    if (person !== undefined) return personCaller(scope, person);
    const view = yield* profiles.require(scope, "hub.manage", { host: alias });
    return {
      actor: actorOf(scope),
      profile: view.profile.id,
      // Disabled goatclaw resolves to the default profile, so it never counts as owner.
      owner: view.enabled && view.profile.id === "owner",
      inbox: { kind: "agent", scope } satisfies DecisionInbox.DecisionCaller,
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
    extra: {
      readonly parity?: HubParityResult;
      readonly decisionId?: string;
      readonly handoff?: HandoffSummary;
      readonly transport?: HubDeviceTransport;
    } = {},
  ): HubDeviceMcpResult => {
    const { handoff, ...rest } = extra;
    const base = { deviceAlias: alias, action, state, message, steps, ...rest };
    // A thread's approval is a handoff; the same tool continues once a person answers it.
    return handoff === undefined || rest.decisionId === undefined
      ? base
      : action === "join"
        ? {
            ...base,
            state: "needs_human",
            decisionId: rest.decisionId,
            kind: "needs_human",
            handoff,
            next: { after: "approval", call: "goat_hub_device_join" },
          }
        : action === "leave"
          ? {
              ...base,
              state: "needs_human",
              decisionId: rest.decisionId,
              kind: "needs_human",
              handoff,
              next: { after: "approval", call: "goat_hub_device_leave" },
            }
          : {
              ...base,
              state: "needs_human",
              decisionId: rest.decisionId,
              kind: "needs_human",
              handoff,
              next: { after: "approval", call: "goat_hub_device_repair" },
            };
  };

  /** Link add, verification and steps 1-3: the shared tail of join and re-link. */
  const link = Effect.fn("HubMembership.link")(function* (
    scope: McpInvocationScope,
    caller: Pick<Caller, "actor" | "profile" | "provisioning" | "gate">,
    action: Action,
    alias: string,
    fingerprint: string,
    decisionId: string | undefined,
    steps: HubDeviceStep[],
  ) {
    if (caller.provisioning && !(yield* provisioned.beginAdd(alias))) {
      const detail = `${alias} is being removed, so GOAT does not link it.`;
      steps.push({ step: "link_add", outcome: "failed", detail });
      return result(action, alias, "failed", detail, steps, { transport: "remote-link" });
    }
    // The last read before the link exists, so a withdrawal during any earlier step stops it.
    if (!(yield* permitted(caller))) {
      if (caller.provisioning) yield* provisioned.abandonAdd(alias);
      return yield* withdrawn(caller, alias, steps);
    }
    const added = yield* ocx.home(
      ["link", "add", alias, "--expect-fingerprint", fingerprint, "--json"],
      LINK_ADD_TIMEOUT_MS,
    );
    const linkId = added.code === 0 ? decodeJson(Added, added.stdout)?.linkId : undefined;
    if (caller.provisioning) yield* provisioned.finishAdd(alias, linkId, homeLinks());
    if (linkId === undefined) {
      steps.push({ step: "link_add", outcome: "failed", detail: phaseMessage(added.phase) });
      yield* audit(caller, `hub.${action}`, alias, "failed", decisionId);
      return result(action, alias, "failed", phaseMessage(added.phase), steps, {
        transport: "remote-link",
      });
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
      { parity: verified, transport: "remote-link" },
    );
  });

  /**
   * Device side first. The Home's own revoke runs a remote `ocx disconnect` whose failure
   * restarts the tunnel (OCX-9), so the Home is touched only after the device is standalone.
   */
  const leaveDevice = Effect.fn("HubMembership.leaveDevice")(function* (
    alias: string,
    steps: HubDeviceStep[],
  ) {
    for (const command of [["disconnect", "--json"], ["restart"]] as const) {
      const ran = yield* ocx.device(alias, command, DEVICE_TIMEOUT_MS).pipe(
        Effect.map((output: OcxOutput) =>
          output.code === 0
            ? { outcome: "ok" as const }
            : { outcome: "failed" as const, detail: `ocx ${command[0]} exited ${output.code}.` },
        ),
        Effect.catch((error) => Effect.succeed(unreachable(error))),
      );
      steps.push({ step: command[0], ...ran });
      if (ran.outcome !== "ok") return ran.detail;
    }
    const body = yield* ocx.deviceHealth(alias);
    const health = body === undefined ? undefined : decodeJson(Health, body);
    // A standalone or Home runtime omits role; anything else still describes the link.
    const standalone =
      health?.service === "opencodex" &&
      (health.role === undefined || health.role === "standalone");
    const detail = standalone
      ? "Device answers as standalone."
      : health === undefined
        ? "Device /healthz did not answer after the restart."
        : `Device /healthz still reports role ${health.role}.`;
    steps.push({ step: "health", outcome: standalone ? "ok" : "failed", detail });
    return standalone ? undefined : detail;
  });

  /** Forced revoke skips the remote cleanup the device step already did; then prove it is gone. */
  const revokeOnHome = Effect.fn("HubMembership.revokeOnHome")(function* (
    alias: string,
    record: { readonly id: string; readonly tunnelPort?: number | undefined },
    steps: HubDeviceStep[],
  ) {
    const revoked = yield* ocx.home(
      ["link", "revoke", "--link-id", record.id, "--force", "--yes", "--json"],
      HOME_TIMEOUT_MS,
    );
    if (revoked.code !== 0 && revoked.phase !== "link_not_found") {
      steps.push({ step: "revoke", outcome: "failed", detail: phaseMessage(revoked.phase) });
      return false;
    }
    steps.push({ step: "revoke", outcome: "ok", detail: record.id });
    const status = yield* homeLinks();
    const recorded =
      status === undefined ||
      status.links.some((entry) => entry.id === record.id || entry.alias === alias);
    const tunnels = yield* ocx.homeTunnels(alias, record.tunnelPort);
    const gone = !recorded && tunnels === 0;
    steps.push({
      step: "link_removed",
      outcome: gone ? "ok" : "failed",
      detail: gone
        ? "No link record or ssh -R tunnel remains."
        : recorded
          ? "ocx link status still lists the link, or could not be read."
          : tunnels === undefined
            ? "This Home's ssh tunnels could not be listed."
            : `${tunnels} ssh -R tunnel for the link is still running.`,
    });
    return gone;
  });

  const homeUnavailable = (action: Action, alias: string, steps: ReadonlyArray<HubDeviceStep>) =>
    result(action, alias, "failed", "This machine's OpenCodex link status is unavailable.", steps);

  /** False when the caller's standing permission no longer holds; an unreadable one does not. */
  const permitted = (caller: Pick<Caller, "gate">) =>
    caller.gate === undefined
      ? Effect.succeed(true)
      : Effect.orElseSucceed(caller.gate, () => false);
  const withdrawn = Effect.fn("HubMembership.withdrawn")(function* (
    caller: Pick<Caller, "actor" | "profile">,
    alias: string,
    steps: HubDeviceStep[],
  ) {
    const detail = `Permission to join ${alias} without asking was withdrawn, so GOAT did not link it.`;
    steps.push({ step: "link_add", outcome: "failed", detail });
    yield* audit(caller, "hub.join", alias, "withdrawn", undefined);
    return result("join", alias, "failed", detail, steps, { transport: "remote-link" });
  });

  const deviceConnection = Effect.fn("HubMembership.deviceConnection")(function* (alias: string) {
    const output = yield* ocx.device(alias, ["connect", "status", "--json"], DEVICE_TIMEOUT_MS);
    return output.code === 0 ? decodeJson(Connection, output.stdout) : undefined;
  });

  /** Asks an owner unless the caller is one; returns a result only when the call must stop. */
  const gate = Effect.fn("HubMembership.gate")(function* (
    caller: Caller,
    action: Action,
    alias: string,
    decisionId: string | undefined,
    binding: string,
    request: { readonly title: string; readonly context: string; readonly reason: string },
    approve: { readonly label: string; readonly consequence: string },
    steps: ReadonlyArray<HubDeviceStep>,
    transport: HubDeviceTransport,
  ) {
    if (decisionId !== undefined) {
      yield* consent.approved(caller, action, decisionId, binding);
      return undefined;
    }
    if (caller.owner) return undefined;
    const requested = yield* consent.request(caller, action, {
      title: request.title,
      context: request.context,
      binding,
      approve: approve.label,
      consequence: approve.consequence,
    });
    yield* audit(caller, `hub.${action}`, alias, "needs_decision", requested.decisionId);
    return result(action, alias, "needs_human", request.reason, steps, {
      ...requested,
      transport,
    });
  });

  /** Hub mode: mint a one-use invite here and redeem it on the device over GOAT SSH (§1.5). */
  const joinHubClient = Effect.fn("HubMembership.joinHubClient")(function* (
    scope: McpInvocationScope,
    caller: Caller,
    alias: string,
    decisionId: string | undefined,
    steps: HubDeviceStep[],
  ) {
    const transport = "hub-client" as const;
    yield* ocx.device(alias, ["--version"], DEVICE_TIMEOUT_MS);
    const current = yield* deviceConnection(alias);
    if (current?.state === "connected") {
      if (current.transport === "link")
        return result(
          "join",
          alias,
          "failed",
          `${alias} still has a Remote Link connection to ${current.serverUrl ?? "another Home"}. Remove it on that Home first.`,
          steps,
          { transport },
        );
      const verified = yield* parity.verify(alias, scope);
      return result(
        "join",
        alias,
        finalState(verified),
        `${alias} is already a Hub client; nothing was changed.`,
        steps,
        { parity: verified, transport },
      );
    }
    const stopped = yield* gate(
      caller,
      "join",
      alias,
      decisionId,
      decisionBinding("join", alias, transport),
      {
        title: `Join ${alias} to the hub as a Hub client`,
        context: `Mints a single-use OpenCodex invite on this hub and redeems it on ${alias} over GOAT SSH. ${alias} gets its own data key and its model traffic goes through this hub.`,
        reason: "Joining a device needs an owner's approval.",
      },
      { label: "Join as Hub client", consequence: `${alias} routes through this hub.` },
      steps,
      transport,
    );
    if (stopped !== undefined) return stopped;
    yield* audit(caller, "hub.join", alias, "started", decisionId);
    const handoff = yield* ocx.connectHubClient(alias, CONNECT_TIMEOUT_MS);
    if (!handoff.minted) {
      const detail =
        handoff.phase === undefined
          ? `ocx hub invite exited ${handoff.exit}. This machine must run OpenCodex in Hub mode with hub.dataPublicOrigin and hub.managementPublicOrigin set.`
          : phaseMessage(handoff.phase);
      steps.push({ step: "invite", outcome: "failed", detail });
      yield* audit(caller, "hub.join", alias, "failed", decisionId);
      return result("join", alias, "failed", detail, steps, { transport });
    }
    steps.push({
      step: "invite",
      outcome: "ok",
      detail: `Single-use code for ${handoff.dataUrl}, expires ${handoff.expiresAt}.`,
    });
    if (handoff.connect.code !== 0) {
      const detail = `ocx connect exited ${handoff.connect.code}; the unused code expires on its own.`;
      steps.push({ step: "connect", outcome: "failed", detail });
      yield* audit(caller, "hub.join", alias, "failed", decisionId);
      return result("join", alias, "failed", detail, steps, { transport });
    }
    steps.push({ step: "connect", outcome: "ok", detail: handoff.dataUrl });
    const verified = yield* ladder(
      scope,
      caller,
      alias,
      undefined,
      yield* parity.verify(alias, scope),
      steps,
    );
    const state = finalState(verified);
    yield* audit(caller, "hub.join", alias, state, decisionId);
    return result(
      "join",
      alias,
      state,
      state === "child"
        ? `${alias} is a Hub client of this hub.`
        : `${alias} is connected, but ${verified.failingCheckIds.join(", ")} still fail.`,
      steps,
      { parity: verified, transport },
    );
  });

  const join = Effect.fn("HubMembership.join")(function* (
    scope: McpInvocationScope,
    input: HubDeviceOperationInput,
    person?: HubPerson,
  ) {
    return yield* joinAs(scope, input, yield* authorize(scope, input.deviceAlias, person));
  });

  const joinAs = Effect.fn("HubMembership.joinAs")(function* (
    scope: McpInvocationScope,
    input: HubDeviceOperationInput,
    caller: Caller,
  ) {
    const alias = input.deviceAlias;
    const steps: HubDeviceStep[] = [];
    return yield* Effect.gen(function* () {
      if (!(yield* permitted(caller))) return yield* withdrawn(caller, alias, steps);
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
          `${alias} is already linked; nothing was changed. Use ${goatCallText("hub.device_repair")} if checks fail.`,
          steps,
          { parity: verified, transport: "remote-link" },
        );
      }
      // OpenCodex refuses a Windows Child only after issuing a key and starting a tunnel (OCX-9).
      const platform = yield* ocx.devicePlatform(alias);
      const transport = input.transport ?? (platform === "windows" ? "hub-client" : "remote-link");
      if (transport === "remote-link" && platform === "windows") {
        steps.push({ step: "preflight", outcome: "failed", detail: WINDOWS_REFUSAL });
        return result("join", alias, "failed", WINDOWS_REFUSAL, steps, { transport });
      }
      steps.push({
        step: "preflight",
        outcome: "ok",
        detail: `${PLATFORM_LABEL[platform ?? "unknown"]}; joining as ${transport}.`,
      });
      if (transport === "hub-client")
        return yield* joinHubClient(scope, caller, alias, input.decisionId, steps);
      if (!(yield* ocx.directAlias(alias)))
        return result(
          "join",
          alias,
          "failed",
          `${alias} does not resolve to a direct SSH host. Use a direct Tailscale alias without ProxyJump or ProxyCommand.`,
          steps,
          { transport },
        );
      // Ready means OpenCodex answers on the device; installing it is a separate, consented step.
      yield* ocx.device(alias, ["--version"], DEVICE_TIMEOUT_MS);
      const offered = yield* probe(alias);
      if (!offered.ok) {
        steps.push({ step: "probe", outcome: "failed", detail: phaseMessage(offered.phase) });
        return result("join", alias, "failed", phaseMessage(offered.phase), steps, { transport });
      }
      steps.push({
        step: "probe",
        outcome: "ok",
        detail: `${offered.keyType} ${offered.fingerprint}`,
      });
      const pin = yield* ocx.pinnedFingerprint(alias);
      const binding = decisionBinding("join", alias, offered.fingerprint);
      if (caller.pinnedOnly && pin !== offered.fingerprint) {
        const detail =
          pin === undefined
            ? "GOAT has no pinned host key for this machine."
            : `GOAT's pinned key is ${pin}, which differs from the offered key.`;
        steps.push({ step: "probe", outcome: "failed", detail });
        yield* audit(caller, "hub.join", alias, "failed", undefined);
        return result("join", alias, "failed", detail, steps, { transport });
      }
      if (input.decisionId !== undefined)
        yield* consent.approved(caller, "join", input.decisionId, binding);
      else if (pin !== offered.fingerprint || !caller.owner) {
        const reason =
          pin === undefined
            ? "GOAT has no pinned host key for this alias."
            : pin !== offered.fingerprint
              ? `GOAT's pinned key is ${pin}, which differs from the offered key.`
              : "Joining a device needs an owner's approval.";
        const requested = yield* consent.request(caller, "join", {
          title: `Join ${alias} to the hub`,
          context: `OpenCodex offers ${offered.keyType} ${offered.fingerprint} for ${alias}. ${reason} Approving links ${alias} as a Remote Link Child; its model traffic then goes through this Home.`,
          binding,
          approve: "Join with this key",
          consequence: `${alias} routes through this Home.`,
        });
        yield* audit(caller, "hub.join", alias, "needs_decision", requested.decisionId);
        return result("join", alias, "needs_human", reason, steps, { ...requested, transport });
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

  /** The hub's half of a Hub client leaving: revoke its data key once the device is standalone. */
  const revokeKey = Effect.fn("HubMembership.revokeKey")(function* (
    id: string,
    steps: HubDeviceStep[],
  ) {
    const revoked = yield* ocx.home(
      ["access", "key", "remove", id, "--yes", "--json"],
      HOME_TIMEOUT_MS,
    );
    steps.push(
      revoked.code === 0
        ? { step: "revoke", outcome: "ok", detail: id }
        : {
            step: "revoke",
            outcome: "failed",
            detail: `ocx access key remove exited ${revoked.code}.`,
          },
    );
    return revoked.code === 0;
  });

  const leave = Effect.fn("HubMembership.leave")(function* (
    scope: McpInvocationScope,
    input: HubDeviceOperationInput,
    person?: HubPerson,
  ) {
    const alias = input.deviceAlias;
    const caller = yield* authorize(scope, alias, person);
    const steps: HubDeviceStep[] = [];
    return yield* Effect.gen(function* () {
      const status = yield* homeLinks();
      if (status === undefined) return homeUnavailable("leave", alias, steps);
      const record = status.links.find((entry) => entry.alias === alias);
      let member: Member;
      if (record !== undefined)
        member = { kind: "remote-link", id: record.id, tunnelPort: record.tunnelPort };
      else {
        const connection = yield* deviceConnection(alias);
        if (
          connection?.state !== "connected" ||
          connection.transport === "link" ||
          connection.apiKeyId === undefined
        )
          return result("leave", alias, "ready", `${alias} is not joined to this hub.`, steps);
        member = { kind: "hub-client", id: connection.apiKeyId };
      }
      const transport = member.kind;
      const what = member.kind === "remote-link" ? `link ${member.id}` : `data key ${member.id}`;
      const binding = decisionBinding("leave", alias, member.id);
      const forceBinding = decisionBinding("leave-force", alias, member.id);
      // A forced removal is only ever a person's answer to a device that could not be cleaned up.
      const forced =
        input.decisionId !== undefined &&
        (yield* consent.forced(caller, input.decisionId, forceBinding));
      const stopped = yield* gate(
        caller,
        "leave",
        alias,
        input.decisionId,
        forced ? forceBinding : binding,
        {
          title: `Remove ${alias} from the hub`,
          context: `Disconnects ${alias}, which returns to its own OpenCodex settings, then revokes ${what} on this hub.`,
          reason: "Removing a device needs an owner's approval.",
        },
        { label: "Remove it", consequence: `${alias} stops routing through this hub.` },
        steps,
        transport,
      );
      if (stopped !== undefined) return stopped;
      yield* audit(caller, "hub.leave", alias, "started", input.decisionId);
      if (!forced) {
        const failure = yield* leaveDevice(alias, steps);
        if (failure !== undefined) {
          const requested = yield* consent.request(caller, "leave", {
            title: `Force-remove ${alias} from the hub`,
            context: `Cleaning up ${alias} failed: ${failure} The hub still holds ${what}. Forcing revokes it here without the device's help; ${alias} keeps its client settings until someone runs ocx disconnect and ocx restart there.`,
            binding: forceBinding,
            approve: "Force-revoke",
            consequence: `${alias} stops routing through this hub but keeps stale client settings.`,
          });
          yield* audit(caller, "hub.leave", alias, "needs_decision", requested.decisionId);
          return result(
            "leave",
            alias,
            "needs_human",
            `${failure} The hub's ${what} was left in place.`,
            steps,
            { ...requested, transport },
          );
        }
      }
      const clean =
        member.kind === "remote-link"
          ? yield* revokeOnHome(alias, member, steps)
          : yield* revokeKey(member.id, steps);
      const revoked = steps.some(({ step, outcome }) => step === "revoke" && outcome === "ok");
      const state = clean && !forced ? "ready" : revoked ? "degraded" : "failed";
      yield* audit(caller, "hub.leave", alias, state, input.decisionId);
      return result(
        "leave",
        alias,
        state,
        state === "ready"
          ? `${alias} left the hub.`
          : !revoked
            ? `The hub did not revoke ${what}.`
            : forced
              ? `The hub revoked ${what}; run ocx disconnect and ocx restart on ${alias} to finish.`
              : "The Home revoked the link, but a link record or tunnel remains.",
        steps,
        { transport },
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
    person?: HubPerson,
  ) {
    const alias = input.deviceAlias;
    const caller = yield* authorize(scope, alias, person);
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
        yield* consent.approved(
          caller,
          "repair",
          input.decisionId,
          decisionBinding("relink", alias, offered.fingerprint),
        );
        yield* audit(caller, "hub.relink", alias, "started", input.decisionId);
        const failure = yield* leaveDevice(alias, steps);
        const clean = failure === undefined && (yield* revokeOnHome(alias, record, steps));
        if (!clean) {
          yield* audit(caller, "hub.relink", alias, "failed", input.decisionId);
          return result(
            "repair",
            alias,
            "failed",
            failure === undefined
              ? "Re-link stopped: the old link record or tunnel remains on this Home."
              : `Re-link stopped before touching the Home link: ${failure}`,
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
      const requested = yield* consent.request(caller, "repair", {
        title: `Re-link ${alias}`,
        context: `${exhausted} Re-linking revokes link ${record.id}, disconnects ${alias} and joins it again with ${offered.keyType} ${offered.fingerprint}; routing is briefly gone.`,
        binding: decisionBinding("relink", alias, offered.fingerprint),
        approve: "Re-link",
        consequence: `${alias} loses routing until the new link is verified.`,
      });
      yield* audit(caller, "hub.repair", alias, "needs_decision", requested.decisionId);
      return result("repair", alias, "needs_human", exhausted, steps, {
        parity: repaired,
        ...requested,
      });
    }).pipe(
      Effect.catchTags({
        HubOcxError: (error) =>
          Effect.succeed(result("repair", alias, "failed", error.message, steps)),
      }),
    );
  });

  return HubMembership.of({
    join: (scope, input, person) => permit.withPermits(1)(join(scope, input, person)),
    leave: (scope, input, person) => permit.withPermits(1)(leave(scope, input, person)),
    repair: (scope, input, person) => permit.withPermits(1)(repair(scope, input, person)),
    joinProvisioned: (scope, alias, gate) =>
      SAFE_ALIAS.test(alias) && hasCloudMachineAliasPrefix(alias)
        ? permit.withPermits(1)(
            joinAs(
              scope,
              { deviceAlias: alias, transport: "remote-link" },
              {
                actor: "goat:cloud-machine",
                profile: "hub",
                owner: true,
                inbox: { kind: "agent", scope },
                provisioning: true,
                pinnedOnly: true,
                gate,
              },
            ),
          )
        : Effect.fail(invalid("Only a cloud machine GOAT created joins without a person.")),
    joinWithConsent: (scope, alias, consent) =>
      SAFE_ALIAS.test(alias) && !hasCloudMachineAliasPrefix(alias)
        ? permit.withPermits(1)(
            Effect.gen(function* () {
              const person = yield* consent;
              if (person === undefined)
                return yield* withdrawn({ actor: "goat:ssh-host", profile: "person" }, alias, []);
              const gate = Effect.map(
                consent,
                (current) => current?.sessionId === person.sessionId,
              );
              return yield* joinAs(
                scope,
                { deviceAlias: alias, transport: "remote-link" },
                { ...personCaller(scope, person), pinnedOnly: true, gate },
              );
            }),
          )
        : Effect.fail(
            invalid("Only an SSH host GOAT set up joins on a person's standing consent."),
          ),
    ...provisioned.releases({
      permit,
      audit,
      homeLinks: homeLinks(),
      revokeOnHome,
      homeTunnels: ocx.homeTunnels,
    }),
  });
});

export const layerWithoutDependencies = Layer.effect(HubMembership, make);
export const layer = layerWithoutDependencies.pipe(Layer.provide(ApprovalHandoffs.layer));
