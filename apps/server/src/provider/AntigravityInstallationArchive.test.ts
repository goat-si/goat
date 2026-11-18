import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderInstallState } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { downloadVerifiedArchive, extractRuntime } from "./AntigravityInstallationArchive.ts";
import { serverContents } from "./AntigravityInstallation.testkit.ts";

// One 20-byte regular member named "antigravity", from upstream 4099e62767's migration fixture.
const nativeTar = Buffer.from(
  "H4sIAAAAAAACE+3RMQ7CQAwEQNe8Ik8wgYj3XIFQCiiOCxK/56CJRA9CYqZZrxsXLpc2n2q5ze0en5LdYZpe2b1n5rhf5+d+m+MuY8j4guXaSu3n4z+V9f9DXXo5HzcBAAAAAAAAAADAz3sA56lbdQAoAAA=",
  "base64",
);
const asset = {
  version: "1.5.7",
  url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.7-1/linux-x64/cli_linux_x64.tar.gz",
  sha512: "0".repeat(128),
  executable: { name: "antigravity" },
  format: "tar.gz",
} as const;
const idle: ProviderInstallState = {
  driver: ProviderDriverKind.make("antigravity"),
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  canRemove: false,
  message: null,
};

it.layer(NodeServices.layer)("Antigravity archive guards", (it) => {
  it.effect("stops a native executable's extraction once it passes its size cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agy-archive-" });
      const archivePath = path.join(directory, "cli.tar.gz");
      yield* fs.writeFile(archivePath, nativeTar);
      const extract = (maxExecutableBytes: number) =>
        Effect.gen(function* () {
          const pairDirectory = path.join(directory, String(maxExecutableBytes));
          yield* fs.makeDirectory(pairDirectory);
          yield* extractRuntime({
            fs,
            path,
            spawner,
            platform: "linux",
            environment: { PATH: process.env.PATH },
            asset,
            archivePath,
            pairDirectory,
            maxExecutableBytes,
          });
          return path.join(pairDirectory, "antigravity");
        });
      const refused = yield* extract(19).pipe(Effect.flip);
      expect(refused.message).toContain("exceeded its size limit");
      expect(yield* fs.readFileString(yield* extract(20))).toBe(serverContents);
    }),
  );

  it.effect("fetches nothing from a host outside Google's, even past the release parser", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agy-archive-" });
      const requests: Array<string> = [];
      const refused = yield* downloadVerifiedArchive({
        http: HttpClient.make((request) =>
          Effect.sync(() => requests.push(request.url)).pipe(
            Effect.andThen(Effect.die("A foreign host must not be fetched")),
          ),
        ),
        fs,
        state: yield* SubscriptionRef.make(idle),
        asset: {
          ...asset,
          url: "https://storage.example.com/antigravity-cli/cli_linux_x64.tar.gz",
        },
        archivePath: path.join(directory, "cli.tar.gz"),
      }).pipe(Effect.flip);
      expect(refused.message).toBe("The Antigravity download is not hosted by Google.");
      expect(requests).toEqual([]);
    }),
  );
});
