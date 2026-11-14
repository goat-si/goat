import { probeHostKey } from "@goat/ssh/hostKey";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

/**
 * The ED25519 SSH host key a destination negotiates now, trusted or not, read with a disposable
 * known_hosts. Kept-machine route paths compare it with disposable machines' sshd pins, which are
 * ED25519 fingerprints; a client that prefers another type (OpenSSH before 8.5) is told to use this one.
 */
export class SshHostKeys extends Context.Service<
  SshHostKeys,
  {
    /** The SHA256 fingerprint; undefined when the destination cannot be probed or offers no ED25519 key. */
    readonly negotiatedFingerprint: (target: {
      readonly alias: string;
      readonly username: string | null;
      readonly port: number | null;
    }) => Effect.Effect<string | undefined>;
  }
>()("goat/sshRemote/SshHostKeys") {}

export const layer = Layer.effect(
  SshHostKeys,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    return SshHostKeys.of({
      negotiatedFingerprint: Effect.fn("SshHostKeys.negotiatedFingerprint")(function* (target) {
        const key = yield* probeHostKey({
          target: target.alias,
          ...(target.username === null ? {} : { user: target.username }),
          ...(target.port === null ? {} : { port: target.port }),
          hostKeyAlgorithms: "ssh-ed25519",
        }).pipe(Effect.provide(services), Effect.option);
        return key._tag === "Some" && key.value.algorithm === "ssh-ed25519"
          ? key.value.fingerprint
          : undefined;
      }),
    });
  }),
);
