import {
  type HandoffSummary,
  type HubDeviceMcpResult,
  type HubDeviceMoveInput,
  type HubDeviceStep,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { hubDeviceResult as result } from "./hubDeviceResult.ts";
import { joinPreflight } from "./hubJoinPreflight.ts";
import type { Caller, HubPerson } from "./HubMembership.ts";
import type { HubOcx, HubOcxError } from "./HubOcx.ts";
import type { LinkStatus } from "./hubOcxJson.ts";

/** One approval covers the whole move: both aliases, the old link, the new key and the machine. */
const moveBinding = (
  from: string,
  fromLinkId: string,
  to: string,
  fingerprint: string,
  environment: string,
) => `goat-hub-binding: move ${from} ${fromLinkId} ${to} ${fingerprint} ${environment}`;

type Offer =
  | { readonly ok: true; readonly fingerprint: string; readonly keyType: string }
  | {
      readonly ok: false;
      readonly phase?: string | undefined;
      readonly message?: string | undefined;
    };

export interface MoveDeps {
  readonly ocx: HubOcx["Service"];
  readonly pinned: boolean;
  readonly authorize: (
    scope: McpInvocationScope,
    alias: string,
    person: HubPerson | undefined,
  ) => Effect.Effect<Caller, OrchestratorMcpFailure>;
  readonly readHomeLinks: () => Effect.Effect<
    { readonly status: typeof LinkStatus.Type | undefined; readonly forbidden: boolean },
    HubOcxError
  >;
  readonly homeUnavailable: (
    alias: string,
    forbidden: boolean,
    steps: ReadonlyArray<HubDeviceStep>,
  ) => HubDeviceMcpResult;
  readonly probe: (alias: string) => Effect.Effect<Offer, HubOcxError>;
  readonly phaseMessage: (offer: Extract<Offer, { readonly ok: false }>) => string;
  readonly request: (
    caller: Caller,
    input: {
      readonly title: string;
      readonly context: string;
      readonly binding: string;
      readonly approve: string;
      readonly consequence: string;
    },
  ) => Effect.Effect<
    { readonly decisionId: string; readonly handoff?: HandoffSummary },
    OrchestratorMcpFailure
  >;
  readonly approved: (
    caller: Caller,
    decisionId: string,
    binding: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly audit: (
    caller: Caller,
    target: string,
    outcome: string,
    decisionId: string | undefined,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly leaveDevice: (
    alias: string,
    member: string,
    admission: Caller["connection"],
    steps: HubDeviceStep[],
  ) => Effect.Effect<string | undefined, HubOcxError>;
  readonly revokeOnHome: (
    alias: string,
    record: { readonly id: string; readonly tunnelPort?: number | undefined },
    steps: HubDeviceStep[],
  ) => Effect.Effect<boolean, HubOcxError>;
  readonly link: (
    scope: McpInvocationScope,
    caller: Caller,
    alias: string,
    fingerprint: string,
    decisionId: string | undefined,
    steps: HubDeviceStep[],
  ) => Effect.Effect<HubDeviceMcpResult, OrchestratorMcpFailure | HubOcxError>;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * hub.device_move: leave the old alias, then link the new one, under one approval with join's
 * lifetime. Every bound value is read live, except the old link id once that link is gone; the
 * caller passes it back and the approval check authenticates it with the rest of the binding.
 */
export const makeMove = (deps: MoveDeps) =>
  Effect.fn("HubMembership.move")(function* (
    scope: McpInvocationScope,
    input: HubDeviceMoveInput,
    person?: HubPerson,
  ) {
    const { fromAlias: from, toAlias: to } = input;
    if (from === to) return yield* invalid("fromAlias and toAlias must name different aliases.");
    const caller = yield* deps.authorize(scope, to, person);
    // The old alias changes too: the caller needs it as well, and its leave runs under it.
    const fromCaller = yield* deps.authorize(scope, from, person);
    const steps: HubDeviceStep[] = [];
    const done = (
      state: "child" | "ready" | "degraded" | "needs_human" | "failed",
      message: string,
      extra: { readonly fromLinkId?: string } = {},
    ) => result("move", to, state, message, steps, { transport: "remote-link", ...extra });
    return yield* Effect.gen(function* () {
      const { status, forbidden } = yield* deps.readHomeLinks();
      if (status === undefined) return deps.homeUnavailable(to, forbidden, steps);
      if (status.role === "child")
        return done("failed", "This machine is a Child and cannot be a Home.");
      const fromEnvironment = yield* deps.ocx.identify(from);
      const toEnvironment = yield* deps.ocx.identify(to);
      if (fromEnvironment === undefined || toEnvironment === undefined)
        return done(
          "failed",
          `GOAT on ${fromEnvironment === undefined ? from : to} did not identify itself, so GOAT cannot tell that both aliases are one machine.`,
        );
      if (fromEnvironment !== toEnvironment)
        return done("failed", `${from} and ${to} name different machines, so this is not a move.`);
      // Target first: nothing at the old alias is touched for a target that is already linked.
      if (status.links.some((entry) => entry.alias === to))
        return done("failed", `${to} is already linked; nothing was changed.`);
      const record = status.links.find((entry) => entry.alias === from);
      if (record === undefined && input.decisionId === undefined)
        return done("failed", `${from} has no link on this Home to move.`);
      const fromLinkId = record?.id ?? input.fromLinkId;
      if (fromLinkId === undefined)
        return done(
          "failed",
          `The link of ${from} is already gone; pass fromLinkId from the earlier result to continue.`,
        );
      const continuing = { fromLinkId };
      const preflight = joinPreflight(
        to,
        yield* deps.ocx.devicePlatform(to),
        "remote-link",
        deps.pinned,
      );
      steps.push({
        step: "preflight",
        outcome: preflight.ok ? "ok" : "failed",
        detail: preflight.detail,
      });
      if (!preflight.ok) return done("failed", preflight.detail, continuing);
      if (!(yield* deps.ocx.directAlias(to)))
        return done(
          "failed",
          `${to} does not resolve to a direct SSH host. Use a direct alias, such as a Tailscale alias or a pen-<name> alias from pen ssh-config.`,
          continuing,
        );
      const offered = yield* deps.probe(to);
      if (!offered.ok) {
        steps.push({ step: "probe", outcome: "failed", detail: deps.phaseMessage(offered) });
        return done("failed", deps.phaseMessage(offered), continuing);
      }
      steps.push({
        step: "probe",
        outcome: "ok",
        detail: `${offered.keyType} ${offered.fingerprint}`,
      });
      const binding = moveBinding(from, fromLinkId, to, offered.fingerprint, fromEnvironment);
      if (input.decisionId !== undefined) yield* deps.approved(caller, input.decisionId, binding);
      else {
        const pin = yield* deps.ocx.pinnedFingerprint(to, offered.keyType);
        if (pin !== offered.fingerprint || !caller.owner) {
          const reason =
            pin !== offered.fingerprint
              ? `GOAT has no matching pinned host key for ${to}.`
              : "Moving a device needs an owner's approval.";
          const requested = yield* deps.request(caller, {
            title: `Move ${from} to ${to}`,
            context: `${from} and ${to} are one machine (${fromEnvironment}). Moving disconnects ${from}, revokes its link ${fromLinkId} on this Home, then links ${to} with ${offered.keyType} ${offered.fingerprint}. ${reason} Routing is briefly gone.`,
            binding,
            approve: "Move it",
            consequence: `${to} routes through this Home instead of ${from}.`,
          });
          yield* deps.audit(caller, to, "needs_decision", requested.decisionId);
          return result("move", to, "needs_human", reason, steps, {
            ...requested,
            transport: "remote-link",
            fromLinkId,
          });
        }
      }
      yield* deps.audit(caller, to, "started", input.decisionId);
      const later =
        input.decisionId === undefined
          ? `Join ${to} with goat_hub_device_join.`
          : `Call goat_hub_device_move again with this decisionId and fromLinkId ${fromLinkId}.`;
      if (record !== undefined) {
        const failure = yield* deps.leaveDevice(from, record.id, fromCaller.connection, steps);
        const clean = failure === undefined && (yield* deps.revokeOnHome(from, record, steps));
        if (!clean) {
          yield* deps.audit(caller, to, "failed", input.decisionId);
          return done(
            "failed",
            failure === undefined
              ? `Move stopped: the old link record or tunnel for ${from} remains on this Home. ${later}`
              : `Move stopped before touching the Home link: ${failure}`,
            continuing,
          );
        }
      } else {
        // The old link went earlier; its Home tunnel must be gone before the new link is added.
        const tunnels = yield* deps.ocx.homeTunnels(from, undefined);
        const gone = tunnels === 0;
        steps.push({
          step: "link_removed",
          outcome: gone ? "ok" : "failed",
          detail: gone
            ? `No link record or ssh -R tunnel for ${from} remains.`
            : tunnels === undefined
              ? "This Home's ssh tunnels could not be listed."
              : `${tunnels} ssh -R tunnel to ${from} is still running.`,
        });
        if (!gone) {
          yield* deps.audit(caller, to, "failed", input.decisionId);
          return done(
            "failed",
            `Move stopped before linking ${to}: the old tunnel is not proven gone. ${later}`,
            continuing,
          );
        }
      }
      const linked = yield* deps.link(
        scope,
        caller,
        to,
        offered.fingerprint,
        input.decisionId,
        steps,
      );
      return linked.state === "failed"
        ? { ...linked, fromLinkId, message: `${linked.message} ${later}` }
        : linked;
    }).pipe(
      Effect.catchTags({
        HubOcxError: (error) => Effect.succeed(done("failed", error.message)),
      }),
    );
  });
