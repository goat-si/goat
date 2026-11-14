import { expect, it } from "@effect/vitest";
import { HubDeviceRoutesUpdateResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { HubOcxError, type OcxOutput } from "./HubOcx.ts";
import { scope, setup, threadScope } from "./HubMembership.testkit.ts";

const LINK = "lnk_0123456789abcdef";
const decodeResult = Schema.decodeUnknownSync(HubDeviceRoutesUpdateResult);
const add = { deviceAlias: "mini", change: { op: "add" as const, route: "pen-mini", position: 0 } };
const routesOf = (routes: ReadonlyArray<string>): OcxOutput => ({
  code: 0,
  stdout: JSON.stringify({ linkId: LINK, pin: "mini", routes }),
});
// An OpenCodex that stores each edit, as ocx link routes does through the Home's API.
const routesHome = () => {
  let routes = ["mini"];
  return (args: ReadonlyArray<string>) => {
    const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    if (args[2] === "add") routes = [value("--route"), ...routes];
    if (args[2] === "remove") routes = routes.filter((route) => route !== value("--route"));
    if (args[2] === "order") routes = value("--routes").split(",");
    return routesOf(routes);
  };
};
const routesCalls = (calls: ReadonlyArray<string>) =>
  calls.filter((call) => call.includes("link routes"));

it.effect(
  "an owner changes a Child's routes at once through ocx link routes, and the list reads them back",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ linked: ["mini"], routes: routesHome() });
      const changed = yield* hub.membership.updateRoutes(scope, add);
      expect(changed).toMatchObject({
        state: "ok",
        linkId: LINK,
        pin: "mini",
        routes: ["pen-mini", "mini"],
      });
      expect(routesCalls(hub.calls)).toEqual([
        `home link routes add --link-id ${LINK} --route pen-mini --position 0 --json`,
      ]);
      const listed = yield* hub.membership.routes(scope, { deviceAlias: "mini" });
      expect(listed.routes).toEqual(["pen-mini", "mini"]);
      expect((yield* hub.inboxItems).items).toEqual([]);
    }),
);

it.effect(
  "another profile asks a person first; the approval binds the link and this exact change, and once spent cannot run it again",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ profile: "hub-admin", linked: ["mini"], routes: routesHome() });
      const asked = yield* hub.membership.updateRoutes(scope, add);
      expect(asked.state).toBe("needs_human");
      expect(decodeResult(asked).decisionId).toBe(asked.decisionId);
      expect(routesCalls(hub.calls)).toEqual([]);
      const [item] = (yield* hub.inboxItems).items;
      for (const named of ["mini", LINK, "add pen-mini at position 0"])
        expect(item?.context).toContain(named);
      yield* hub.approve(asked.decisionId!);
      const other = yield* Effect.flip(
        hub.membership.updateRoutes(scope, {
          deviceAlias: "mini",
          change: { op: "remove", route: "mini" },
          decisionId: asked.decisionId!,
        }),
      );
      expect(other.code).toBeDefined();
      expect(routesCalls(hub.calls)).toEqual([]);
      const changed = yield* hub.membership.updateRoutes(scope, {
        ...add,
        decisionId: asked.decisionId!,
      });
      expect(changed.state).toBe("ok");
      expect((yield* hub.consumed).map(({ approval_id }) => approval_id)).toEqual([
        asked.decisionId,
      ]);
      const again = yield* Effect.flip(
        hub.membership.updateRoutes(scope, { ...add, decisionId: asked.decisionId! }),
      );
      expect(again.code).toBeDefined();
      expect(routesCalls(hub.calls)).toHaveLength(1);
    }),
);

it.effect("OpenCodex's refusal comes back as a failure with its fixed code and cause", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      linked: ["mini"],
      routes: () => ({ code: 5, stdout: "", phase: "route_unproven", cause: "hostkey" }),
    });
    const refused = yield* hub.membership.updateRoutes(scope, add);
    expect(refused).toMatchObject({ state: "failed", code: "route_unproven", cause: "hostkey" });
    expect(refused.message).toContain("pinned host key");
    expect(refused.message).toContain("(hostkey)");
  }),
);

it.effect(
  "a Home whose OpenCodex has no ocx link routes answers unsupported for a list and a change",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ linked: ["mini"] });
      expect((yield* hub.membership.routes(scope, { deviceAlias: "mini" })).state).toBe(
        "unsupported",
      );
      expect((yield* hub.membership.updateRoutes(scope, add)).state).toBe("unsupported");
    }),
);

it.effect("a device with no link on this Home is refused before ocx link routes runs", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ linked: ["other"], routes: routesHome() });
    const refused = yield* hub.membership.updateRoutes(scope, add);
    expect(refused.state).toBe("failed");
    expect(refused.message).toContain("no Remote Link");
    expect(routesCalls(hub.calls)).toEqual([]);
  }),
);

it.effect(
  "an exclusive link lists its one route as exclusive, and refuses a change in plain words",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({
        linked: ["mini"],
        routes: (args) =>
          args[2] === "add"
            ? { code: 5, stdout: "", phase: "link_exclusive" }
            : {
                code: 0,
                stdout: JSON.stringify({
                  linkId: LINK,
                  pin: "mini",
                  routes: ["mini"],
                  exclusive: true,
                }),
              },
      });
      expect(yield* hub.membership.routes(scope, { deviceAlias: "mini" })).toMatchObject({
        state: "ok",
        routes: ["mini"],
        exclusive: true,
      });
      const refused = yield* hub.membership.updateRoutes(scope, add);
      expect(refused).toMatchObject({ state: "failed", code: "link_exclusive" });
      expect(refused.message).toBe(
        "This link is exclusive: its one route is fixed, so routes cannot be added, removed or reordered.",
      );
    }),
);

it.effect("a link the Child opened, and a position past the end, are refused in plain words", () =>
  Effect.gen(function* () {
    const answers: Array<OcxOutput> = [
      { code: 5, stdout: "", phase: "link_not_home_initiated" },
      { code: 2, stdout: "", phase: "invalid_body" },
    ];
    const hub = yield* setup({
      linked: ["mini"],
      routes: () => answers.shift() ?? routesOf(["mini"]),
    });
    const joined = yield* hub.membership.routes(scope, { deviceAlias: "mini" });
    expect(joined).toMatchObject({ state: "failed", code: "link_not_home_initiated" });
    expect(joined.message).toBe(
      "This Child opened its own link to the Home, so the Home has no routes for it to change.",
    );
    const past = yield* hub.membership.updateRoutes(scope, add);
    expect(past).toMatchObject({ state: "failed", code: "invalid_body" });
    expect(past.message).toBe(
      "OpenCodex refused the change as malformed, such as a position past the end of the list.",
    );
  }),
);
it.effect(
  "a change ocx did not answer in time may still finish on the Home: it says to read the routes again and spends the approval",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({
        profile: "hub-admin",
        linked: ["mini"],
        routes: () => ({ code: 124, stdout: "" }),
      });
      const asked = yield* hub.membership.updateRoutes(scope, add);
      yield* hub.approve(asked.decisionId!);
      const timedOut = yield* hub.membership.updateRoutes(scope, {
        ...add,
        decisionId: asked.decisionId!,
      });
      expect(timedOut.state).toBe("failed");
      expect(timedOut.message).toBe(
        "ocx link routes did not answer within 2 minutes. The Home may still finish the change, so read the routes again before you retry it.",
      );
      expect((yield* hub.consumed).map(({ approval_id }) => approval_id)).toEqual([
        asked.decisionId,
      ]);
    }),
);
it.effect(
  "an agent whose host list names the device but not the new route is refused before ocx link routes runs",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ profile: "hub-mini", linked: ["mini"], routes: routesHome() });
      expect((yield* hub.membership.routes(scope, { deviceAlias: "mini" })).state).toBe("ok");
      for (const change of [
        { op: "add" as const, route: "pen-mini" },
        { op: "remove" as const, route: "pen-mini" },
        { op: "order" as const, routes: ["pen-mini", "mini"] },
      ]) {
        const refused = yield* Effect.flip(
          hub.membership.updateRoutes(scope, { deviceAlias: "mini", change }),
        );
        expect(refused.code).toBeDefined();
      }
      expect(routesCalls(hub.calls)).toEqual([`home link routes --link-id ${LINK} --json`]);
      expect((yield* hub.inboxItems).items).toEqual([]);
    }),
);
it.effect(
  "a route in OpenCodex's wider alias form, such as jun@mini, can be removed and reordered; a leading dash or a comma is refused before ocx runs",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ linked: ["mini"], routes: routesHome() });
      const wide = { deviceAlias: "mini", change: { op: "add" as const, route: "jun@mini" } };
      expect((yield* hub.membership.updateRoutes(scope, wide)).routes).toEqual([
        "jun@mini",
        "mini",
      ]);
      const order = { op: "order" as const, routes: ["mini", "jun@mini"] };
      expect(
        (yield* hub.membership.updateRoutes(scope, { deviceAlias: "mini", change: order })).routes,
      ).toEqual(["mini", "jun@mini"]);
      const remove = { op: "remove" as const, route: "jun@mini" };
      expect(
        (yield* hub.membership.updateRoutes(scope, { deviceAlias: "mini", change: remove })).routes,
      ).toEqual(["mini"]);
      for (const route of ["-oProxyCommand=x", "a,b"]) {
        const refused = yield* Effect.flip(
          hub.membership.updateRoutes(scope, { deviceAlias: "mini", change: { op: "add", route } }),
        );
        expect(refused.code).toBe("invalid_request");
      }
      expect(routesCalls(hub.calls)).toHaveLength(3);
    }),
);
const approvedChange = Effect.fn("routesTest.approvedChange")(function* (
  routes: (args: ReadonlyArray<string>) => OcxOutput,
  run?: (args: ReadonlyArray<string>) => Effect.Effect<OcxOutput, HubOcxError> | undefined,
) {
  const hub = yield* setup({
    profile: "hub-admin",
    linked: ["mini"],
    routes,
    ...(run === undefined
      ? {}
      : { routesRun: (args) => run(args) ?? Effect.succeed(routes(args)) }),
  });
  const asked = yield* hub.membership.updateRoutes(scope, add);
  yield* hub.approve(asked.decisionId!);
  return { hub, decisionId: asked.decisionId! };
});

it.effect(
  "a fixed refusal leaves the approval unspent, so the same approved change runs once its cause is fixed",
  () =>
    Effect.gen(function* () {
      const home = routesHome();
      let refuse = true;
      const { hub, decisionId } = yield* approvedChange((args) =>
        refuse ? { code: 5, stdout: "", phase: "route_unproven", cause: "transient" } : home(args),
      );
      const refused = yield* hub.membership.updateRoutes(scope, { ...add, decisionId });
      expect(refused).toMatchObject({ state: "failed", code: "route_unproven" });
      expect(yield* hub.consumed).toEqual([]);
      refuse = false;
      const changed = yield* hub.membership.updateRoutes(scope, { ...add, decisionId });
      expect(changed.routes).toEqual(["pen-mini", "mini"]);
      expect((yield* hub.consumed).map(({ approval_id }) => approval_id)).toEqual([decisionId]);
    }),
);

it.effect("a change the Home stored but could not apply yet spends its approval", () =>
  Effect.gen(function* () {
    const { hub, decisionId } = yield* approvedChange(() => ({
      code: 1,
      stdout: "",
      phase: "routes_stored_reload_failed",
    }));
    const stored = yield* hub.membership.updateRoutes(scope, { ...add, decisionId });
    expect(stored).toMatchObject({ state: "ok", code: "routes_stored_reload_failed" });
    expect((yield* hub.consumed).map(({ approval_id }) => approval_id)).toEqual([decisionId]);
  }),
);

it.effect(
  "a thread's change asks through a handoff whose id is the decision, and continues with it",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ profile: "hub-admin", linked: ["mini"], routes: routesHome() });
      const asked = yield* hub.membership.updateRoutes(threadScope, add);
      expect(asked).toMatchObject({
        state: "needs_human",
        kind: "needs_human",
        handoff: { kind: "approval", state: "pending", targetPath: "hub.device_routes_update" },
        next: { after: "approval", call: "goat_hub_device_routes_update" },
      });
      expect((asked as { handoff: { handoffId: string } }).handoff.handoffId).toBe(
        asked.decisionId,
      );
      expect(hub.handoffReason(asked.decisionId!)).toContain("add pen-mini at position 0");
      expect(routesCalls(hub.calls)).toEqual([]);
      yield* hub.answer(asked.decisionId!);
      const changed = yield* hub.membership.updateRoutes(threadScope, {
        ...add,
        decisionId: asked.decisionId!,
      });
      expect(changed.routes).toEqual(["pen-mini", "mini"]);
    }),
);
it.effect(
  "an approved change whose ocx stopped after it started, or was interrupted, spends the approval; ocx missing before it ran keeps it",
  () =>
    Effect.gen(function* () {
      const lost = yield* approvedChange(routesHome(), (args) =>
        args[2] === "add"
          ? Effect.fail(
              new HubOcxError({ reason: "unreachable", message: "ocx could not be run here." }),
            )
          : undefined,
      );
      const stopped = yield* lost.hub.membership.updateRoutes(scope, {
        ...add,
        decisionId: lost.decisionId,
      });
      expect(stopped.state).toBe("failed");
      expect(stopped.message).toBe(
        "ocx stopped before it answered. The Home may still finish the change, so read the routes again before you retry it.",
      );
      expect((yield* lost.hub.consumed).map(({ approval_id }) => approval_id)).toEqual([
        lost.decisionId,
      ]);

      const started = yield* Deferred.make<void>();
      const hung = yield* approvedChange(routesHome(), (args) =>
        args[2] === "add"
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          : undefined,
      );
      const fiber = yield* hung.hub.membership
        .updateRoutes(scope, { ...add, decisionId: hung.decisionId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect((yield* hung.hub.consumed).map(({ approval_id }) => approval_id)).toEqual([
        hung.decisionId,
      ]);

      const missing = yield* approvedChange(routesHome(), (args) =>
        args[2] === "add"
          ? Effect.fail(
              new HubOcxError({
                reason: "ocx_missing",
                message: "OpenCodex is not installed on this hub.",
              }),
            )
          : undefined,
      );
      const refused = yield* missing.hub.membership.updateRoutes(scope, {
        ...add,
        decisionId: missing.decisionId,
      });
      expect(refused.state).toBe("failed");
      expect(yield* missing.hub.consumed).toEqual([]);
    }),
);
it.effect(
  "an approved change whose ocx could not be started keeps the approval and says nothing changed",
  () =>
    Effect.gen(function* () {
      const { hub, decisionId } = yield* approvedChange(routesHome(), (args) =>
        args[2] === "add"
          ? Effect.fail(
              new HubOcxError({
                reason: "ocx_unstartable",
                message: "ocx could not be started on this hub.",
              }),
            )
          : undefined,
      );
      const refused = yield* hub.membership.updateRoutes(scope, { ...add, decisionId });
      expect(refused).toMatchObject({
        state: "failed",
        code: "ocx_unstartable",
        message: "ocx could not be started on this hub, so nothing changed.",
      });
      expect(yield* hub.consumed).toEqual([]);
    }),
);
it.effect(
  "every failure before ocx starts answers with a code, so a waiting change stays continuable, and keeps the approval",
  () =>
    Effect.gen(function* () {
      const cases = [
        { kind: "unstartable" as const, code: "ocx_unstartable" },
        { kind: "missing" as const, code: "ocx_missing" },
        { kind: "unreachable" as const, code: "link_status_unreadable" },
        { kind: "failed" as const, code: "link_status_unreadable" },
        { kind: "child" as const, code: "this_machine_is_child" },
        { kind: "unlinked" as const, code: "link_not_found" },
      ];
      for (const { kind, code } of cases) {
        const { hub, decisionId } = yield* approvedChange(routesHome());
        if (kind === "unlinked") hub.unlink("mini");
        else hub.breakLinkStatus(kind);
        const failed = yield* hub.membership.updateRoutes(scope, { ...add, decisionId });
        expect(failed, kind).toMatchObject({ state: "failed", code });
        expect(yield* hub.consumed, kind).toEqual([]);
        expect(routesCalls(hub.calls), kind).toEqual([]);
      }
    }),
);
it.effect(
  "a routes read that fails after the link status was read does not blame the status read",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({
        linked: ["mini"],
        routesRun: () =>
          Effect.fail(
            new HubOcxError({ reason: "unreachable", message: "ocx could not be run here." }),
          ),
      });
      const listed = yield* hub.membership.routes(scope, { deviceAlias: "mini" });
      expect(listed.state).toBe("failed");
      expect(listed.code).toBeUndefined();
      expect(listed.message).toBe("ocx could not be run here.");
    }),
);
