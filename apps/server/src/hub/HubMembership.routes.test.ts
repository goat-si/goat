import { expect, it } from "@effect/vitest";
import { HubDeviceRoutesUpdateResult } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OcxOutput } from "./HubOcx.ts";
import { scope, setup } from "./HubMembership.testkit.ts";

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
  "another profile asks a person first; the approval binds the link and this exact change, and is spent once",
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
