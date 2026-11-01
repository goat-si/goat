import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parse } from "./ComputerUseLeaseProtocol.ts";
import { refuseProxyCall } from "./ComputerUseLeaseProxyRefusal.ts";
import { approvedApps, type ListedApp } from "./ComputerUseScope.ts";

const PID = 4100;
const call = (name: string, args: Record<string, unknown>) =>
  parse(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  ) ?? {};

/** One call judged as the proxy judges it before it forwards it, with or without strict guards. */
const judge = (input: {
  readonly strict: boolean;
  readonly app: string;
  readonly approved: ReadonlyArray<string> | undefined;
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly tokenFirst?: boolean;
  readonly shared?: boolean;
}) =>
  refuseProxyCall({
    id: 1,
    message: call(input.name ?? "click", input.args ?? { pid: PID, window_id: 9, x: 1, y: 1 }),
    finished: () => undefined,
    paused: () => undefined,
    idle: () => false,
    apps: () => approvedApps(input.approved),
    listed: new Map<number, ListedApp>([
      [PID, { id: input.app, bundleId: input.app, name: "App" }],
    ]),
    host: { bundleIds: true },
    shared: () => input.shared === true,
    toFile: () => undefined,
    tokenFirstRefuses: () => input.tokenFirst === true,
    strict: () => input.strict,
    foreground: () => [],
    listApps: Effect.void,
  });

const refusedAs = (refused: unknown) => JSON.stringify(refused ?? null);

describe("the proxy's own refusals follow the strict input guards setting", () => {
  it.effect("an app outside the approved list is refused only with strict guards", () =>
    Effect.gen(function* () {
      const base = { app: "com.example.Other", approved: ["com.example.Editor"] };
      assert.include(refusedAs(yield* judge({ ...base, strict: true })), "app_not_approved");
      assert.isUndefined(yield* judge({ ...base, strict: false }));
    }),
  );
  it.effect("token_first is refused only with strict guards", () =>
    Effect.gen(function* () {
      const base = { app: "com.example.Editor", approved: undefined, tokenFirst: true };
      assert.include(refusedAs(yield* judge({ ...base, strict: true })), "token_first");
      assert.isUndefined(yield* judge({ ...base, strict: false }));
    }),
  );
  it.effect("bringing a window forward needs foreground approval only with strict guards", () =>
    Effect.gen(function* () {
      const base = {
        app: "com.example.Editor",
        approved: undefined,
        name: "bring_to_front",
        args: { pid: PID, window_id: 9 },
      };
      assert.include(refusedAs(yield* judge({ ...base, strict: true })), "foreground_not_approved");
      assert.isUndefined(yield* judge({ ...base, strict: false }));
    }),
  );
  it.effect("a protected app stays out of reach without strict guards", () =>
    Effect.gen(function* () {
      const refused = yield* judge({
        app: "com.apple.keychainaccess",
        approved: undefined,
        strict: false,
      });
      assert.include(refusedAs(refused), "app_not_allowed");
    }),
  );
});
