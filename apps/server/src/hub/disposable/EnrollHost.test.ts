import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../processRunner.ts";
import { journalServed, reachAnswerOf } from "./EnrollHost.ts";

const WINDOWS = HostProcess.Platform.defaultValue() === "win32";
const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

// A stand-in ocx: the full journal listing of a busy Home is far past HubOcx's 256 KiB cap.
it.live.skipIf(WINDOWS)(
  "a Home that serves its journal is known by the exit code, however long the list",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const big = path.join(dir, "ocx-big");
      yield* fs.writeFileString(big, "#!/bin/sh\nhead -c 600000 /dev/zero | tr '\\0' x\nexit 0\n");
      yield* fs.chmod(big, 0o755);
      const missing = path.join(dir, "ocx-missing");
      yield* fs.writeFileString(
        missing,
        "#!/bin/sh\necho 'does not serve GET /api/link/operations' >&2\nexit 4\n",
      );
      yield* fs.chmod(missing, 0o755);
      expect(yield* journalServed(big, {})).toBe(true);
      expect(yield* journalServed(missing, {})).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it("ssh's own whole lines decide how a reach ended; a banner cannot", () => {
  expect(reachAnswerOf(0, "")).toBe("ok");
  expect(reachAnswerOf(255, "runner@pen-x: Permission denied (publickey).")).toBe("key_refused");
  expect(reachAnswerOf(255, "Host key verification failed.")).toBe("host_key_changed");
  expect(reachAnswerOf(255, "kex_exchange_identification: Connection closed by remote host")).toBe(
    "unreachable",
  );
  // A machine's banner repeating ssh's words is not ssh's own line.
  expect(
    reachAnswerOf(
      255,
      "Welcome! Host key verification failed. is our motto\nrunner@pen-x: Permission denied (publickey).",
    ),
  ).toBe("key_refused");
  // GOAT's own known_hosts file is gone: ssh says no key is known, which is a wait, not a conflict.
  expect(
    reachAnswerOf(
      255,
      "No ED25519 host key is known for pen-x and you have requested strict checking.\nHost key verification failed.",
    ),
  ).toBe("host_key_unknown");
});
