import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

/** A fresh coordinator whose redemptions follow `script`: "uncertain" keeps the key pending. */
const scriptedCoordinator = (script: Array<"uncertain" | "settled">) =>
  Effect.gen(function* () {
    const real = yield* Effect.service(ResetCreditCoordinator.ResetCreditCoordinator).pipe(
      Effect.provide(ResetCreditCoordinator.layerTest),
    );
    const keys: Array<string> = [];
    const service = ResetCreditCoordinator.ResetCreditCoordinator.of({
      redeem: (accountKey, _consume, isSettled) =>
        real.redeem(
          accountKey,
          (idempotencyKey) =>
            Effect.suspend(() => {
              keys.push(idempotencyKey);
              return script.shift() === "uncertain"
                ? Effect.die("timed out")
                : Effect.succeed("nothingToReset" as const);
            }),
          isSettled,
        ),
    });
    return { service, keys };
  });

it.layer(layerTest)("CodexDriver reset credits", (it) => {
  it.effect("two homes that differ only by a trailing space are separate accounts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const { service, keys } = yield* scriptedCoordinator(["uncertain", "settled", "settled"]);
      const host: NodeJS.ProcessEnv = { PATH: "", CODEX_HOME: `${root}/a` };
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("reset-credit-spaced"),
        displayName: "Codex reset credit test",
        enabled: true,
        environment: [],
        config: CodexDriver.defaultConfig(),
      }).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(HostProcess.HomeDirectory, root),
        Effect.provideService(ResetCreditCoordinator.ResetCreditCoordinator, service),
      );
      yield* instance.consumeResetCredit!().pipe(Effect.exit);
      host.CODEX_HOME = `${root}/a `;
      yield* instance.consumeResetCredit!().pipe(Effect.exit);
      host.CODEX_HOME = `${root}/a`;
      yield* instance.consumeResetCredit!().pipe(Effect.exit);
      const [first, other, retry] = keys;
      expect(other).not.toBe(first);
      expect(retry).toBe(first);
    }).pipe(Effect.scoped),
  );

  // Codex resolves CODEX_HOME as written from its working directory, the server's: no trim, no ~;
  // without one it uses .codex under the HOME it receives.
  const spaced = (root: string) => `${root}/user `;
  it.effect.each([
    {
      name: "a host home ending in a space",
      host: (root: string) => ({ CODEX_HOME: spaced(root) }),
      at: (root: string) => spaced(root),
    },
    { name: "a whitespace-only host home", host: () => ({ CODEX_HOME: " " }), at: () => " " },
    {
      name: "a host home starting with ~/",
      host: () => ({ CODEX_HOME: "~/account" }),
      at: () => "~/account",
    },
    {
      name: "a HOME override without CODEX_HOME",
      host: (root: string) => ({ HOME: `${root}/b`, USERPROFILE: `${root}/b` }),
      at: (root: string) => `${root}/b/.codex`,
    },
  ])("$name shares a lock with an instance pinned to the same directory", ({ host: hostEnv, at }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const { service, keys } = yield* scriptedCoordinator(["uncertain", "settled"]);
      const create = (id: string, homePath: string, host: NodeJS.ProcessEnv) =>
        CodexDriver.create({
          instanceId: ProviderInstanceId.make(id),
          displayName: "Codex reset credit test",
          enabled: true,
          environment: [],
          config: { ...CodexDriver.defaultConfig(), homePath },
        }).pipe(
          Effect.provideService(HostProcess.Environment, host),
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(ResetCreditCoordinator.ResetCreditCoordinator, service),
        );
      const following = yield* create("reset-credit-host", "", { PATH: "", ...hostEnv(root) });
      const pinned = yield* create("reset-credit-pinned", path.resolve(at(root)), { PATH: "" });
      yield* following.consumeResetCredit!().pipe(Effect.exit);
      yield* pinned.consumeResetCredit!().pipe(Effect.exit);
      const [first, second] = keys;
      expect(second).toBe(first);
    }).pipe(Effect.scoped),
  );

  it.effect("a redemption refused at the account limit tells the person why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      for (let index = 0; index < ResetCreditCoordinator.MAX_TRACKED_ACCOUNTS; index += 1) {
        yield* coordinator
          .redeem(`${root}/uncertain-${index}`, () => Effect.fail("timed out" as const))
          .pipe(Effect.result);
      }
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("reset-credit-limit"),
        displayName: "Codex reset credit test",
        enabled: true,
        environment: [],
        config: { ...CodexDriver.defaultConfig(), homePath: `${root}/home` },
      }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.HomeDirectory, root),
      );
      const error = yield* instance.consumeResetCredit!().pipe(Effect.flip);
      expect(error.detail).toBe(new ResetCreditCoordinator.ResetCreditAccountLimitError().message);
    }).pipe(Effect.scoped),
  );
});
