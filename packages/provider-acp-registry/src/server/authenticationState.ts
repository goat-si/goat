import type { ProviderInstanceEnvironment, ProviderInstanceId } from "@goat/contracts";
import type { AcpRegistrySettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@goat/shared/atomicWrite";

const decodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ binding: Schema.String, authenticated: Schema.Boolean })),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const hash = Effect.fn("AcpRegistryAuthenticationState.hash")(function* (value: unknown) {
  const crypto = yield* Crypto.Crypto;
  const json = yield* encodeJson(value).pipe(Effect.orDie);
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(json)).pipe(Effect.orDie);
  return Hex.encode(digest);
});

export const makeAcpRegistryAuthenticationState = Effect.fn("makeAcpRegistryAuthenticationState")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
    readonly settings: AcpRegistrySettings;
    readonly environment: ProviderInstanceEnvironment;
    readonly processEnvironment: NodeJS.ProcessEnv;
    readonly currentEnvironment?: Effect.Effect<NodeJS.ProcessEnv>;
  }) {
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(input.cacheDir, `acp-auth-${yield* hash(input.instanceId)}.json`);
    // Cosmetic settings and model discovery do not change the account binding.
    const bindingFor = (processEnvironment: NodeJS.ProcessEnv) =>
      hash({
        ...(input.settings.source === "local"
          ? { source: "local", commandArgs: input.settings.commandArgs }
          : {}),
        agentId: input.settings.agentId,
        commandPath: input.settings.commandPath,
        distribution: input.settings.distribution,
        authMethodId: input.settings.authMethodId,
        environment: [...input.environment].toSorted((a, b) => a.name.localeCompare(b.name)),
        processEnvironment: Object.entries(processEnvironment).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ),
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
    const saved = yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeState),
      Effect.orElseSucceed(() => undefined),
    );
    const confirmed = yield* Ref.make(saved);
    const lock = yield* Semaphore.make(1);
    const currentEnvironment =
      input.currentEnvironment ?? Effect.sync(() => input.processEnvironment);
    const persist = (binding: string, authenticated: boolean) =>
      writeFileStringAtomically({
        filePath,
        contents: JSON.stringify({ binding, authenticated }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.tapError(() => Effect.logWarning("Could not save ACP sign-in confirmation.")),
        Effect.ignore,
      );
    const get = lock.withPermit(
      Effect.gen(function* () {
        const binding = yield* bindingFor(yield* currentEnvironment);
        const state = yield* Ref.get(confirmed);
        if (state?.binding === binding) return state.authenticated;
        yield* Ref.set(confirmed, { binding, authenticated: false });
        if (state !== undefined) yield* persist(binding, false);
        return false;
      }),
    );
    const set = (authenticated: boolean, environment?: NodeJS.ProcessEnv) =>
      lock.withPermit(
        Effect.gen(function* () {
          const currentBinding = yield* bindingFor(yield* currentEnvironment);
          const binding =
            environment === undefined ? currentBinding : yield* bindingFor(environment);
          if (binding !== currentBinding) return;
          yield* Ref.set(confirmed, { binding, authenticated });
          yield* persist(binding, authenticated);
        }),
      );
    // Preserve invalidation when a driver is recreated with another profile.
    yield* get;
    return { get, set };
  },
);
