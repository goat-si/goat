import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import { makeSuccessfulProcess } from "../../../../packages/ssh/src/tunnel.fixture.ts";
import * as SshHostKeys from "./SshHostKeys.ts";

// The pins route guards compare are ED25519 fingerprints, so the layer asks OpenSSH for that type and
// answers nothing for a host that negotiates another (OpenSSH before 8.5 prefers ECDSA).
const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIJqQutSw0XQo7KOx5R7x4wcb2s6h3WPkcz2z6WIeJ3Re";
const FINGERPRINT = "SHA256:WifIJ3Gg9d1V01c9+p+oi1SGRxLsJBBVzcaovKcEIAM";

const negotiated = (offersEd25519: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let type = "";
    const spawner = lazyChildProcessSpawner((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
        if (command.args.includes("-G"))
          return makeSuccessfulProcess("hostname box.example\nport 22\nproxycommand none\n");
        if (command.args.includes("-lf"))
          return makeSuccessfulProcess(
            `256 ${FINGERPRINT} box.example (${type === "ssh-ed25519" ? "ED25519" : "ECDSA"})\n`,
          );
        const asked = command.args.includes("HostKeyAlgorithms=ssh-ed25519");
        type = asked && offersEd25519 ? "ssh-ed25519" : "ecdsa-sha2-nistp256";
        const file = command.args
          .find((arg) => arg.startsWith("UserKnownHostsFile="))!
          .slice("UserKnownHostsFile=".length)
          .replace(/^"|"$/gu, "");
        yield* fs.writeFileString(file, `box.example ${type} ${KEY}\n`);
        return makeSuccessfulProcess("");
      }),
    );
    const keys = yield* SshHostKeys.SshHostKeys.pipe(
      Effect.provide(
        SshHostKeys.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );
    return yield* keys.negotiatedFingerprint({ alias: "box", username: null, port: null });
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("asks OpenSSH for the ED25519 key, so a client that prefers ECDSA still reports it", () =>
  Effect.gen(function* () {
    expect(yield* negotiated(true)).toBe(FINGERPRINT);
  }),
);

it.effect("answers nothing for a host that offers no ED25519 key", () =>
  Effect.gen(function* () {
    expect(yield* negotiated(false)).toBeUndefined();
  }),
);
