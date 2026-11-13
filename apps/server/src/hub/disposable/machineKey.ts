// @effect-diagnostics-next-line nodeBuiltinImport:off -- a temporary key name per creation.
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../../config.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../../processRunner.ts";

/** The hub's own key for disposable machines: GOAT's private file and the line a machine trusts. */
export interface MachineIdentity {
  readonly privateKeyFile: string;
  /** "ssh-ed25519 <base64> goat-disposable", for the machine user's authorized_keys. */
  readonly publicLine: string;
}

export class MachineKeyError extends Data.TaggedError("MachineKeyError")<{
  readonly message: string;
}> {}

/** One ed25519 key per hub, made once and never rewritten; the person's own ssh keys are never used. */
export class MachineKey extends Context.Service<
  MachineKey,
  {
    /** The key, made on first use. */
    readonly identity: Effect.Effect<MachineIdentity, MachineKeyError>;
    /** The key if it was made; a read never makes one. */
    readonly known: Effect.Effect<MachineIdentity | undefined>;
  }
>()("goat/hub/disposable/machineKey") {}

const COMMENT = "goat-disposable";
const PUBLIC_LINE = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/u;
/** The public line ssh-keygen wrote, with GOAT's comment; undefined for anything else. */
const machinePublicLine = (text: string) => {
  const [type, blob] = text.trim().split(" ");
  const line = type + " " + blob;
  return PUBLIC_LINE.test(line) ? line + " " + COMMENT : undefined;
};

/**
 * Makes the key with ssh-keygen in GOAT's state folder (0700), under a lock so two first uses make
 * one key. An existing private key is kept; its public line is derived again when missing.
 */
export const make = Effect.fn("MachineKey.make")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const once = (yield* Semaphore.make(1)).withPermits(1);
  const privateKeyFile = path.join(directory, "machine_ed25519");
  const failed = (message: string) => () => new MachineKeyError({ message });
  const keygen = (args: ReadonlyArray<string>) =>
    runner
      .run({ command: "ssh-keygen", args, timeout: "30 seconds", maxOutputBytes: 64 * 1024 })
      .pipe(
        Effect.filterOrFail((output) => output.code === 0, failed("ssh-keygen failed.")),
        Effect.mapError(failed("ssh-keygen could not make the machine key.")),
      );
  const readPublic = fs.readFileString(privateKeyFile + ".pub").pipe(
    Effect.map(machinePublicLine),
    Effect.orElseSucceed(() => undefined),
  );
  const create = Effect.gen(function* () {
    if (!(yield* fs.exists(privateKeyFile).pipe(Effect.orElseSucceed(() => false)))) {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(directory, 0o700);
      const temporary = privateKeyFile + ".new-" + NodeCrypto.randomUUID();
      yield* keygen(["-q", "-t", "ed25519", "-N", "", "-C", COMMENT, "-f", temporary]);
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary + ".pub", privateKeyFile + ".pub");
      // The private file appears last: once it exists, the key is made.
      yield* fs.rename(temporary, privateKeyFile);
    }
    const known = yield* readPublic;
    if (known !== undefined) return known;
    const derived = yield* keygen(["-y", "-f", privateKeyFile]);
    const line = machinePublicLine(derived.stdout);
    if (line === undefined) return yield* failed("The machine key is not an ed25519 key.")();
    yield* fs.writeFileString(privateKeyFile + ".pub", line + "\n");
    return line;
  }).pipe(
    Effect.catchTags({ PlatformError: failed("GOAT could not store its machine key.") }),
    once,
  );
  const known = Effect.gen(function* () {
    if (!(yield* fs.exists(privateKeyFile).pipe(Effect.orElseSucceed(() => false))))
      return undefined;
    const publicLine = yield* readPublic;
    return publicLine === undefined ? undefined : { privateKeyFile, publicLine };
  });
  return MachineKey.of({
    known,
    identity: Effect.map(create, (publicLine) => ({ privateKeyFile, publicLine })).pipe(
      Effect.withSpan("MachineKey.identity"),
    ),
  });
});

export const layer = Layer.effect(
  MachineKey,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(config.stateDir, "disposable"));
  }),
);
