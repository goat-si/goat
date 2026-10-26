import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { GOAT_CONNECT_CLI_COMING_SOON_MESSAGE } from "@goat/shared/goatConnect";
import * as NetService from "@goat/shared/Net";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, vi } from "vite-plus/test";

beforeEach(() => {
  vi.stubEnv("GOAT_RELAY_URL", "https://relay.wp1.invalid");
  vi.stubEnv("GOAT_CLERK_PUBLISHABLE_KEY", "pk_test_Y2xlcmsud3AxLmludmFsaWQk");
  vi.stubEnv("GOAT_CLERK_CLI_OAUTH_CLIENT_ID", "oauth_wp1_synthetic");
});
afterEach(() => vi.unstubAllEnvs());
import { makeCli, runCliWithArgs } from "./binCli.ts";

const tails = [
  [],
  ["login", "--headless"],
  ["link", "--publish-only", "--base-dir", "/missing/path"],
  ["publish", "on"],
  ["status", "--json"],
  ["unlink"],
  ["logout"],
  ["unknown", "nested", "--totally-unknown=value"],
  ["--help"],
  ["login", "--help"],
  ["--version"],
  ["--bad-flag", "--base-dir"],
  ["--", "--help", "arbitrary"],
];

it.effect.each(tails.map((tail) => ({ tail, name: tail.join(" ") })))(
  "connect $name prints once and succeeds without runtime access",
  ({ tail }) =>
    Effect.gen(function* () {
      const log = vi.fn();
      const console = yield* Console.Console;
      const exit = yield* runCliWithArgs(
        ["connect", ...tail],
        makeCli({ cloudEnabled: true }),
      ).pipe(Effect.provideService(Console.Console, { ...console, log }), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(log.mock.calls).toEqual([[GOAT_CONNECT_CLI_COMING_SOON_MESSAGE]]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NetService.layer))),
);

it.effect("preserves root help, version and invalid-command parsing", () =>
  Effect.gen(function* () {
    const log = vi.fn();
    const console = yield* Console.Console;
    const capture = Effect.provideService(Console.Console, { ...console, log, error: log });
    for (const args of [["--help"], ["--version"]]) {
      const exit = yield* runCliWithArgs(args).pipe(capture, Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }
    expect(
      Exit.isFailure(yield* runCliWithArgs(["nonexistent-command"]).pipe(capture, Effect.exit)),
    ).toBe(true);
    expect(log.mock.calls.flat()).not.toContain(GOAT_CONNECT_CLI_COMING_SOON_MESSAGE);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NetService.layer))),
);
