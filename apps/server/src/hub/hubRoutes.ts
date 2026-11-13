import {
  type HandoffSummary,
  type HubDeviceRoutesChange,
  type HubDeviceRoutesInput,
  type HubDeviceRoutesResult,
  type HubDeviceRoutesUpdateInput,
  type HubDeviceRoutesUpdateResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { linkStatusUnreadable } from "./hubDeviceResult.ts";
import type { Caller, HubPerson } from "./HubMembership.ts";
import { type HubOcx, type HubOcxError, type OcxOutput, SAFE_ALIAS } from "./HubOcx.ts";
import type { LinkStatus } from "./hubOcxJson.ts";

// An add proves the pinned key over the new route with an SSH probe first.
const ROUTES_TIMEOUT_MS = 120_000;
const decodeRoutes = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      linkId: Schema.String,
      pin: Schema.String,
      routes: Schema.Array(Schema.String),
      exclusive: Schema.optional(Schema.Literal(true)),
    }),
  ),
);

/** OpenCodex's fixed refusal codes for ocx link routes, in words a person can act on. */
const REFUSAL: Readonly<Record<string, string>> = {
  route_unproven: "The Home could not prove the link's pinned host key over that route",
  route_exists: "That route is already in the list.",
  route_limit: "The link already has as many routes as OpenCodex allows.",
  route_is_pin: "The link's pinned alias stays in the list; it cannot be removed.",
  route_order_mismatch: "A new order must name exactly the routes the link has.",
  route_not_found: "That route is not in the list.",
  link_not_found: "The Home has no such link.",
  link_not_home_initiated:
    "This Child opened its own link to the Home, so the Home has no routes for it to change.",
  invalid_body:
    "OpenCodex refused the change as malformed, such as a position past the end of the list.",
  invalid_link_id: "OpenCodex refused the link id as malformed.",
  link_changed: "The link changed while the edit ran. Read the routes and try again.",
  pin_changed: "The link's pinned key changed while the edit ran. Read the routes and try again.",
  pin_mismatch: "The Home's known key for this link does not match its pin, so nothing changed.",
  trust_file_unexpected:
    "The Home's known_hosts entry for this link is not in the shape OpenCodex expects, so nothing changed.",
  link_operation_in_progress: "Another change to this link is running. Try again when it finishes.",
  link_exclusive:
    "This link is exclusive: its one route is fixed, so routes cannot be added, removed or reordered.",
  routes_stored_reload_failed:
    "The change was stored, but the Home could not apply it yet; it applies once OpenCodex restarts there.",
};

const routesArgs = (linkId: string, change?: HubDeviceRoutesChange) => {
  const target = ["--link-id", linkId];
  if (change === undefined) return ["link", "routes", ...target, "--json"];
  if (change.op === "add")
    return [
      "link",
      "routes",
      "add",
      ...target,
      "--route",
      change.route,
      ...(change.position === undefined ? [] : ["--position", String(change.position)]),
      "--json",
    ];
  if (change.op === "remove")
    return ["link", "routes", "remove", ...target, "--route", change.route, "--json"];
  return ["link", "routes", "order", ...target, "--routes", change.routes.join(","), "--json"];
};

const describe = (change: HubDeviceRoutesChange) =>
  change.op === "add"
    ? `add ${change.route}${change.position === undefined ? "" : ` at position ${change.position}`}`
    : change.op === "remove"
      ? `remove ${change.route}`
      : `order ${change.routes.join(", ")}`;

const changeAliases = (change: HubDeviceRoutesChange) =>
  change.op === "order" ? change.routes : [change.route];

export interface RoutesDeps {
  readonly ocx: HubOcx["Service"];
  readonly authorize: (
    scope: McpInvocationScope,
    alias: string,
    person: HubPerson | undefined,
  ) => Effect.Effect<Caller, OrchestratorMcpFailure>;
  readonly readHomeLinks: () => Effect.Effect<
    { readonly status: typeof LinkStatus.Type | undefined; readonly forbidden: boolean },
    HubOcxError
  >;
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
  readonly used: (
    caller: Caller,
    decisionId: string | undefined,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly audit: (
    caller: Caller,
    target: string,
    outcome: string,
    decisionId: string | undefined,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** What ocx link routes answered, as a result; refusals keep OpenCodex's fixed words only. */
const routesAnswer = (alias: string, linkId: string, output: OcxOutput): HubDeviceRoutesResult => {
  const base = { deviceAlias: alias, linkId };
  if (output.code === 0) {
    const document = Option.getOrUndefined(decodeRoutes(output.stdout.trim()));
    return document !== undefined && document.linkId === linkId
      ? {
          ...base,
          state: "ok",
          message: document.exclusive
            ? `${alias} has one fixed, exclusive route.`
            : `${alias} has ${document.routes.length} route(s).`,
          pin: document.pin,
          routes: document.routes,
          ...(document.exclusive ? { exclusive: true as const } : {}),
        }
      : {
          ...base,
          state: "failed",
          message: "OpenCodex answered ocx link routes with a document GOAT could not read.",
        };
  }
  // A usage error with no refusal code: this ocx has no routes command.
  if (output.code === 2 && output.phase === undefined)
    return {
      ...base,
      state: "unsupported",
      message:
        "This Home's OpenCodex has no ocx link routes. Update OpenCodex on this Home to change a Child's routes.",
    };
  const explained = output.phase === undefined ? undefined : REFUSAL[output.phase];
  if (output.phase !== undefined && explained !== undefined) {
    const code = {
      code: output.phase,
      ...(output.cause === undefined ? {} : { cause: output.cause }),
    };
    if (output.phase === "routes_stored_reload_failed")
      return { ...base, ...code, state: "ok", message: explained };
    return {
      ...base,
      ...code,
      state: "failed",
      message:
        output.phase === "route_unproven"
          ? `${explained}${output.cause === undefined ? "" : ` (${output.cause})`}.`
          : explained,
    };
  }
  return {
    ...base,
    state: "failed",
    message: `ocx link routes exited ${output.code} on this Home. Run ocx link routes --link-id ${linkId} there to see why.`,
  };
};

/**
 * hub.device_routes and hub.device_routes_update: a Remote Link Child's SSH routes on this Home.
 * A change by an owner or a person in Settings runs at once; any other profile asks a person,
 * and the approval binds the link and this exact change.
 */
export const makeRoutes = (deps: RoutesDeps) => {
  const linkOf = Effect.fn("HubMembership.routesLink")(function* (alias: string) {
    const { status, forbidden } = yield* deps.readHomeLinks();
    if (status === undefined) return { failed: linkStatusUnreadable(forbidden) } as const;
    if (status.role === "child")
      return { failed: "This machine is a Child and has no Home links." } as const;
    const record = status.links.find((entry) => entry.alias === alias);
    return record === undefined
      ? ({ failed: `${alias} has no Remote Link on this Home.` } as const)
      : ({ linkId: record.id } as const);
  });
  const unreachable = (alias: string) => (error: HubOcxError) =>
    Effect.succeed<HubDeviceRoutesResult>({
      deviceAlias: alias,
      state: "failed",
      message: error.message,
    });

  const list = Effect.fn("HubMembership.routes")(function* (
    scope: McpInvocationScope,
    input: HubDeviceRoutesInput,
    person?: HubPerson,
  ) {
    const alias = input.deviceAlias;
    yield* deps.authorize(scope, alias, person);
    return yield* Effect.gen(function* () {
      const link = yield* linkOf(alias);
      if ("failed" in link)
        return {
          deviceAlias: alias,
          state: "failed",
          message: link.failed,
        } satisfies HubDeviceRoutesResult;
      return routesAnswer(
        alias,
        link.linkId,
        yield* deps.ocx.home(routesArgs(link.linkId), ROUTES_TIMEOUT_MS),
      );
    }).pipe(Effect.catchTags({ HubOcxError: unreachable(alias) }));
  });

  const update = Effect.fn("HubMembership.updateRoutes")(function* (
    scope: McpInvocationScope,
    input: HubDeviceRoutesUpdateInput,
    person?: HubPerson,
  ) {
    const { deviceAlias: alias, change } = input;
    if (!changeAliases(change).every((route) => SAFE_ALIAS.test(route)))
      return yield* invalid("Each route must be a plain SSH alias.");
    const caller = yield* deps.authorize(scope, alias, person);
    return yield* Effect.gen(function* () {
      const link = yield* linkOf(alias);
      if ("failed" in link)
        return {
          deviceAlias: alias,
          state: "failed",
          message: link.failed,
        } satisfies HubDeviceRoutesUpdateResult;
      const binding = `goat-hub-binding: routes ${alias} ${link.linkId} ${describe(change)}`;
      if (input.decisionId !== undefined) yield* deps.approved(caller, input.decisionId, binding);
      else if (!caller.owner) {
        const requested = yield* deps.request(caller, {
          title: `Change the routes of ${alias}`,
          context: `The Home tries these SSH routes in order for the Remote Link of ${alias} (link ${link.linkId}). Change: ${describe(change)}. A new route is stored only after it proves the link's pinned host key. Changing routes needs an owner's approval.`,
          binding,
          approve: "Change the routes",
          consequence: `The Home uses the new route list for ${alias} from its next connection.`,
        });
        yield* deps.audit(caller, alias, "needs_decision", requested.decisionId);
        const base = {
          deviceAlias: alias,
          state: "needs_human" as const,
          message: "Changing a Child's routes needs an owner's approval.",
          linkId: link.linkId,
          decisionId: requested.decisionId,
        };
        return requested.handoff === undefined
          ? base
          : {
              ...base,
              kind: "needs_human" as const,
              handoff: requested.handoff,
              next: { after: "approval" as const, call: "goat_hub_device_routes_update" as const },
            };
      }
      yield* deps.audit(caller, alias, "started", input.decisionId);
      const answer = routesAnswer(
        alias,
        link.linkId,
        yield* deps.ocx.home(routesArgs(link.linkId, change), ROUTES_TIMEOUT_MS),
      );
      if (answer.state === "ok") yield* deps.used(caller, input.decisionId);
      yield* deps.audit(caller, alias, answer.code ?? answer.state, input.decisionId);
      return answer;
    }).pipe(Effect.catchTags({ HubOcxError: unreachable(alias) }));
  });

  return { list, update };
};
