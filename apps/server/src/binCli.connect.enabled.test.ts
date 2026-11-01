import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { GOAT_CONNECT_CLI_COMING_SOON_MESSAGE } from "@goat/shared/goatConnect";
import * as NetService from "@goat/shared/Net";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { makeCli, runCliWithArgs } from "./binCli.ts";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

it.effect("reports missing public configuration and fails when Connect is enabled", () =>
  Effect.gen(function* () {
    const log = vi.fn();
    const console = yield* Console.Console;
    const exit = yield* runCliWithArgs(
      ["connect", "status"],
      makeCli({ cloudEnabled: false }),
    ).pipe(Effect.provideService(Console.Console, { ...console, log, error: log }), Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    const reported = [
      ...log.mock.calls.flat().map(String),
      Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
    ].join("\n");
    expect(reported).toContain("missing GOAT Connect public configuration");
    expect(reported).not.toContain(GOAT_CONNECT_CLI_COMING_SOON_MESSAGE);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NetService.layer))),
);
