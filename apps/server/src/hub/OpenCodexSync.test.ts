import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OpenCodexInventorySnapshot,
  type OpenCodexSyncReport,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { HubOcx, HubOcxError, type OcxOutput, SYNC_EXIT } from "./HubOcx.ts";
import { layer as syncLayer, OpenCodexSync } from "./OpenCodexSync.ts";
import { OpenCodexUpdateHost } from "./OpenCodexUpdateHost.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

type Child = "mac-studio" | "lidge-ts" | "macmini-ts";
/** The Home's own link order, which every report follows. */
const CHILDREN: ReadonlyArray<Child> = ["macmini-ts", "lidge-ts", "mac-studio"];
const linkIdOf = (alias: Child) => fleetSnapshot(alias).parityEvidence!.childLinkId!;

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:sync"),
  requestNamespace: "client:sync",
  thread: undefined,
  client: { sessionId: "client:sync", label: "Test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

/** A Home and three Remote Link Children, all idle and connected unless a test says otherwise. */
const makeFleet = () => ({
  linkState: new Map<string, OpenCodexInventorySnapshot["link"]["links"][number]["state"]>(
    CHILDREN.map((alias) => [alias, "connected"]),
  ),
  snapshots: new Map<string | null, OpenCodexInventorySnapshot | undefined>([
    [null, undefined],
    ...CHILDREN.map((alias) => [alias, fleetSnapshot(alias)] as const),
  ]),
  running: new Map<string | null, number | undefined>([
    [null, 0],
    ...CHILDREN.map((alias) => [alias, 0] as const),
  ]),
  homeExit: 0,
  deviceOutput: new Map<string, OcxOutput | "unreachable">(),
  /** What reconnecting each link leaves it in; connected unless named. */
  reconnectTo: new Map<string, "failed">(),
  calls: [] as Array<string>,
  reads: [] as Array<string>,
  holds: 0,
  /** The row each device saw for itself while its own sync ran. */
  during: new Map<string, string | undefined>(),
});
type Fleet = ReturnType<typeof makeFleet>;

const homeSnapshot = (fleet: Fleet): OpenCodexInventorySnapshot => {
  const base = fleetSnapshot("home");
  return {
    ...base,
    link: {
      ...base.link,
      links: base.link.links
        .filter((link) => fleet.linkState.has(link.alias))
        .map((link) => ({ ...link, state: fleet.linkState.get(link.alias)! })),
    },
  };
};

const layer = (fleet: Fleet, seen: { latest?: Effect.Effect<unknown> }) =>
  syncLayer.pipe(
    Layer.provide(
      Layer.mock(OpenCodexUpdateHost)({
        member: (alias) =>
          Effect.sync(() => {
            fleet.reads.push(alias ?? "home");
            return {
              alias,
              snapshot:
                alias === null
                  ? (fleet.snapshots.get(null) ?? homeSnapshot(fleet))
                  : fleet.snapshots.get(alias),
              runningTurns: fleet.running.get(alias),
            };
          }),
        holdAdmission: () =>
          Effect.sync(() => {
            fleet.holds += 1;
            return true;
          }),
        releaseAdmission: () =>
          Effect.sync(() => {
            fleet.holds -= 1;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(HubOcx)({
        home: (args) =>
          Effect.sync(() => {
            fleet.calls.push(`home ${args.join(" ")}`);
            if (args[0] === "link") {
              const alias = [...fleet.linkState.keys()].find(
                (child) => linkIdOf(child as Child) === args[3],
              );
              if (alias !== undefined)
                fleet.linkState.set(alias, fleet.reconnectTo.get(alias) ?? "connected");
              return { code: 0, stdout: "{}" };
            }
            return { code: fleet.homeExit, stdout: "" };
          }),
        syncDevice: (alias, options) =>
          Effect.gen(function* () {
            fleet.calls.push(
              `device ${alias} ${options.linkId}${options.restartCodex ? " --restart-codex" : ""}`,
            );
            const report = (yield* seen.latest!) as
              | { members: ReadonlyArray<{ alias: string | null; state: string }> }
              | undefined;
            fleet.during.set(alias, report?.members.find((row) => row.alias === alias)?.state);
            const output = fleet.deviceOutput.get(alias) ?? { code: 0, stdout: "synchronized" };
            if (output === "unreachable")
              return yield* new HubOcxError({ reason: "unreachable", message: "down" });
            return output;
          }),
      }),
    ),
  );

const setup = Effect.fn("OpenCodexSyncTest.setup")(function* (fleet = makeFleet()) {
  const seen: { latest?: Effect.Effect<unknown> } = {};
  const context = yield* Layer.build(layer(fleet, seen));
  const sync = yield* OpenCodexSync.pipe(Effect.provideContext(context));
  seen.latest = sync.latest;
  return { fleet, sync };
});

const rows = (report: OpenCodexSyncReport) =>
  report.members.map(({ alias, state, reason }) => [alias, state, reason]);

it.effect(
  "syncs this Home first, then each linked Child, restarting Codex only where nothing runs",
  () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.running.set("lidge-ts", 1);
      fleet.running.set("macmini-ts", undefined);
      const { sync } = yield* setup(fleet);
      const report = yield* sync.run(scope);
      expect(fleet.calls).toEqual([
        "home sync --restart-codex",
        `device mac-studio ${linkIdOf("mac-studio")} --restart-codex`,
      ]);
      expect(rows(report)).toEqual([
        [null, "synced", undefined],
        ["macmini-ts", "skipped", "busy"],
        ["lidge-ts", "skipped", "busy"],
        ["mac-studio", "synced", undefined],
      ]);
      // Each machine shows as syncing while its own command runs.
      expect(fleet.during.get("mac-studio")).toBe("syncing");
      expect(fleet.holds).toBe(0);
      expect(yield* sync.latest).toEqual(report);
    }),
);

it.effect("writes a busy Home's catalog and leaves the Codex restart for later", () =>
  Effect.gen(function* () {
    const fleet = makeFleet();
    fleet.running.set(null, 2);
    const { sync } = yield* setup(fleet);
    const report = yield* sync.run(scope);
    expect(fleet.calls[0]).toBe("home sync");
    expect(report.members[0]).toMatchObject({
      alias: null,
      state: "synced",
      restartCodex: false,
      reason: "busy",
    });
  }),
);

it.effect("leaves a busy machine that is itself a Child alone, since its sync can restart it", () =>
  Effect.gen(function* () {
    const fleet = makeFleet();
    fleet.snapshots.set(null, fleetSnapshot("mac-studio"));
    fleet.running.set(null, 1);
    const { sync } = yield* setup(fleet);
    const report = yield* sync.run(scope);
    expect(fleet.calls).toEqual([]);
    expect(rows(report)).toEqual([[null, "skipped", "busy"]]);
  }),
);

it.effect("never syncs a Child that is standalone with its own providers or linked elsewhere", () =>
  Effect.gen(function* () {
    const fleet = makeFleet();
    const own = fleetSnapshot("lidge-ts");
    fleet.snapshots.set("lidge-ts", {
      ...own,
      runtime: { ...own.runtime, role: "standalone" },
      link: { ...own.link, role: "none" },
      parityEvidence: { ...own.parityEvidence!, localProviderCount: 3, childLinkId: undefined },
    });
    const studio = fleetSnapshot("mac-studio");
    fleet.snapshots.set("mac-studio", {
      ...studio,
      parityEvidence: { ...studio.parityEvidence!, childLinkId: "lnk_another_home" },
    });
    const missing = fleetSnapshot("macmini-ts");
    fleet.snapshots.set("macmini-ts", {
      ...missing,
      parityEvidence: { ...missing.parityEvidence!, childLinkId: undefined },
    });
    const { sync } = yield* setup(fleet);
    const report = yield* sync.run(scope);
    expect(fleet.calls).toEqual(["home sync --restart-codex"]);
    expect(rows(report).slice(1)).toEqual([
      ["macmini-ts", "skipped", "not-connected"],
      ["lidge-ts", "skipped", "not-connected"],
      ["mac-studio", "skipped", "not-connected"],
    ]);
  }),
);

it.effect("reconnects a Child's link once, and syncs it only when the Home sees it again", () =>
  Effect.gen(function* () {
    const fleet = makeFleet();
    fleet.linkState.set("mac-studio", "reconnecting");
    fleet.linkState.set("lidge-ts", "failed");
    fleet.linkState.delete("macmini-ts");
    const { sync } = yield* setup(fleet);
    expect(rows(yield* sync.plan(scope)).slice(1)).toEqual([
      ["lidge-ts", "ready", "reconnect"],
      ["mac-studio", "ready", "reconnect"],
    ]);
    expect(fleet.calls).toEqual([]);

    // mac-studio's tunnel comes back; lidge-ts's does not.
    fleet.reconnectTo.set("lidge-ts", "failed");
    const report = yield* sync.run(scope);
    expect(fleet.calls).toEqual([
      "home sync --restart-codex",
      `home link reconnect --link-id ${linkIdOf("lidge-ts")} --json`,
      `home link reconnect --link-id ${linkIdOf("mac-studio")} --json`,
      `device mac-studio ${linkIdOf("mac-studio")} --restart-codex`,
    ]);
    expect(rows(report).slice(1)).toEqual([
      ["lidge-ts", "skipped", "not-connected"],
      ["mac-studio", "synced", undefined],
    ]);
  }),
);

it.effect("reports each machine's failure with its reason", () =>
  Effect.gen(function* () {
    const fleet = makeFleet();
    fleet.homeExit = 1;
    fleet.deviceOutput.set("mac-studio", { code: SYNC_EXIT.connectionChanged, stdout: "" });
    fleet.deviceOutput.set("lidge-ts", { code: SYNC_EXIT.notConnected, stdout: "" });
    fleet.deviceOutput.set("macmini-ts", "unreachable");
    const { sync } = yield* setup(fleet);
    expect(rows(yield* sync.run(scope))).toEqual([
      [null, "failed", "exit-1"],
      ["macmini-ts", "failed", "unreachable"],
      ["lidge-ts", "skipped", "not-connected"],
      ["mac-studio", "failed", "connection-changed"],
    ]);

    fleet.homeExit = 0;
    fleet.deviceOutput.set("mac-studio", {
      code: 0,
      stdout: "Home unavailable; retained and applied the last-known-good remote catalog (stale).",
    });
    expect(rows(yield* sync.run(scope))[3]).toEqual(["mac-studio", "synced", "stale"]);
  }),
);

it.effect(
  "never reads or runs a Child the caller may not reach, even if that changes mid-run",
  () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      const { sync } = yield* setup(fleet);
      let asked = 0;
      const report = yield* sync.run(scope, (alias) =>
        Effect.succeed(
          alias === "lidge-ts" ? false : alias === "mac-studio" ? ++asked === 1 : true,
        ),
      );
      expect(fleet.reads).not.toContain("lidge-ts");
      expect(fleet.calls).toEqual([
        "home sync --restart-codex",
        `device macmini-ts ${linkIdOf("macmini-ts")} --restart-codex`,
      ]);
      expect(rows(report).slice(1)).toEqual([
        ["macmini-ts", "synced", undefined],
        ["lidge-ts", "skipped", "not-permitted"],
        ["mac-studio", "skipped", "not-permitted"],
      ]);
    }),
);

it.effect("holds manual syncs off while an update window is open", () =>
  Effect.gen(function* () {
    const { fleet, sync } = yield* setup();
    yield* sync.markUpdating(true);
    const report = yield* sync.run(scope);
    expect(fleet.calls).toEqual([]);
    expect(
      report.members.every(({ state, reason }) => state === "skipped" && reason === "updating"),
    ).toBe(true);
    expect(report.members).toHaveLength(4);
  }),
);

it.effect("fills one update report across the window's steps", () =>
  Effect.gen(function* () {
    const fleet = makeFleet();
    fleet.deviceOutput.set("mac-studio", { code: 1, stdout: "" });
    const { sync } = yield* setup(fleet);
    yield* sync.beginUpdate("2.91.0");
    yield* sync.syncUpdatedMember(null, scope);
    yield* sync.syncUpdatedMember("mac-studio", scope);
    const report = yield* sync.latest;
    expect(report).toMatchObject({ trigger: "update", targetVersion: "2.91.0" });
    expect(rows(report!)).toEqual([
      [null, "synced", undefined],
      ["mac-studio", "failed", "exit-1"],
    ]);
  }),
);
