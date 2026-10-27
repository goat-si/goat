import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parse } from "./ComputerUseLeaseProtocol.ts";
import { refuseProxyCall } from "./ComputerUseLeaseProxyRefusal.ts";
import { approvedApps, learnApps, type ListedApp } from "./ComputerUseScope.ts";

const PID = 4100;
const CLICK = parse(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "click", arguments: { pid: PID, window_id: 9, x: 1, y: 1 } },
  }),
);
const listing = (executable: string | undefined) => ({
  apps: [{ pid: PID, name: "notes.exe", ...(executable === undefined ? {} : { executable }) }],
});

/** A click on the pid's window, judged as the proxy judges one before it forwards it. */
const click = (input: {
  readonly listed: Map<number, ListedApp>;
  readonly approved: ReadonlyArray<string>;
  readonly executableOf?: (pid: number) => string | undefined;
  readonly listApps: Effect.Effect<void>;
}) =>
  refuseProxyCall({
    id: 1,
    message: CLICK ?? {},
    finished: () => undefined,
    paused: () => undefined,
    idle: () => false,
    apps: () => approvedApps(input.approved),
    listed: input.listed,
    host: {
      bundleIds: false,
      ...(input.executableOf === undefined ? {} : { executableOf: input.executableOf }),
    },
    shared: () => false,
    toFile: () => undefined,
    tokenFirstRefuses: () => false,
    foreground: () => [],
    listApps: input.listApps,
  });

describe("an app approved by its executable path", () => {
  it.effect("is refused when the same pid now runs another binary of the same name", () =>
    Effect.gen(function* () {
      const listed = new Map<number, ListedApp>();
      learnApps(listing("C:\\Good\\notes.exe"), listed, true);
      const refused = yield* click({
        listed,
        approved: ["C:\\Good\\notes.exe"],
        listApps: Effect.sync(() => learnApps(listing("C:\\Other\\notes.exe"), listed, true)),
      });
      assert.include(JSON.stringify(refused), "app_not_approved");
    }),
  );

  it.effect("is refused when a fresh listing cannot confirm its executable", () =>
    Effect.gen(function* () {
      const listed = new Map<number, ListedApp>();
      learnApps(listing("C:\\Good\\notes.exe"), listed, true);
      const refused = yield* click({
        listed,
        approved: ["C:\\Good\\notes.exe"],
        listApps: Effect.void,
      });
      assert.include(JSON.stringify(refused), "app_not_approved");
    }),
  );

  it.effect("runs once a fresh listing confirms the same executable", () =>
    Effect.gen(function* () {
      const listed = new Map<number, ListedApp>();
      learnApps(listing("C:\\Good\\notes.exe"), listed, true);
      const allowed = yield* click({
        listed,
        approved: ["C:\\Good\\notes.exe"],
        listApps: Effect.sync(() => learnApps(listing("C:\\Good\\notes.exe"), listed, true)),
      });
      assert.isUndefined(allowed);
    }),
  );

  it.effect("on Linux is read again from /proc, and refused once the pid runs another binary", () =>
    Effect.gen(function* () {
      let running = "/opt/good/notes";
      const executableOf = (pid: number) => (pid === PID ? running : undefined);
      const listed = new Map<number, ListedApp>();
      learnApps(listing(undefined), listed, true, executableOf);
      const relist = Effect.sync(() => learnApps(listing(undefined), listed, true, executableOf));
      // Still the approved binary: no listing is needed to confirm it.
      assert.isUndefined(
        yield* click({
          listed,
          approved: ["/opt/good/notes"],
          executableOf,
          listApps: Effect.die("confirmed from /proc"),
        }),
      );
      running = "/opt/other/notes";
      const refused = yield* click({
        listed,
        approved: ["/opt/good/notes"],
        executableOf,
        listApps: relist,
      });
      assert.include(JSON.stringify(refused), "app_not_approved");
    }),
  );
});
