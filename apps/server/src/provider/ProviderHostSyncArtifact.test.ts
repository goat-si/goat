// @effect-diagnostics nodeBuiltinImport:off - the pin is computed from the fixture bytes.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { installArtifact } from "./ProviderHostSyncArtifact.ts";
import type { PinnedArtifact } from "./ProviderHostSyncRecipes.ts";

const release = new TextEncoder().encode("the vendor's real release archive");
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const artifact: PinnedArtifact = {
  version: "2026.1.2-abc",
  url: "https://downloads.example.test/{os}/{arch}/package.tar.gz",
  assets: { "linux-x64": { sha256: sha256(release), bytes: release.byteLength } },
  root: ".local/share/tool/versions",
  entry: "tool",
  links: ["tool", "tool-alias"],
};

/** Installs into a fresh home with a server that answers \`body\`; tar is faked and recorded. */
const install = (
  body: Uint8Array,
  options: { readonly status?: number; readonly existing?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-artifact-" });
    if (options.existing !== undefined) {
      yield* fs.makeDirectory(path.join(home, ".local", "bin"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".local", "bin", options.existing), "mine\n");
    }
    const spawned: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = (command as unknown as { args: ReadonlyArray<string> }).args;
      spawned.push(args);
      const into = args[args.indexOf("-C") + 1] ?? "";
      return fs.writeFileString(path.join(into, "tool"), "#!/bin/sh\n").pipe(
        Effect.orDie,
        Effect.as(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    });
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array(body), { status: options.status ?? 200 }),
        ),
      ),
    );
    const result = yield* installArtifact(spawner, "Tool", artifact).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
      Effect.result,
    );
    const versions = path.join(home, ".local", "share", "tool", "versions");
    const left = (yield* fs.readDirectory(versions)).toSorted();
    const bin = path.join(home, ".local", "bin");
    const links = (yield* fs.exists(bin)) ? yield* fs.readDirectory(bin) : [];
    return { result, spawned, left, links, home, fs, path };
  }).pipe(Effect.provide(NodeServices.layer));

it.effect.each([
  {
    body: "same size, other bytes",
    bytes: new TextEncoder().encode("the vendor's fake release archive"),
  },
  { body: "larger than the pin", bytes: new Uint8Array(release.byteLength + 1) },
  { body: "cut short", bytes: release.slice(0, 5) },
])(
  "a download $body fails its SHA-256 check and installs, unpacks and links nothing",
  ({ bytes }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { result, spawned, left, links } = yield* install(bytes);
        expect(Result.isFailure(result) && result.failure.message).toBe(
          "The Tool download did not match GOAT's pinned SHA-256 for 2026.1.2-abc. Nothing was installed.",
        );
        expect(spawned).toEqual([]);
        // The staging folder is removed with its scope; no version folder or link was made.
        expect(left).toEqual([]);
        expect(links).toEqual([]);
      }),
    ),
);

it.effect("a download that matches its pin is unpacked into its version folder and linked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { result, spawned, left, links, home, fs, path } = yield* install(release);
      expect(Result.isSuccess(result)).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.slice(0, 2)).toEqual(["--strip-components=1", "-xzf"]);
      expect(left).toEqual(["2026.1.2-abc"]);
      expect(links.toSorted()).toEqual(["tool", "tool-alias"]);
      const target = path.join(home, ".local", "share", "tool", "versions", "2026.1.2-abc", "tool");
      for (const link of links)
        expect(yield* fs.readLink(path.join(home, ".local", "bin", link))).toBe(target);
    }),
  ),
);

it.effect("a host with no pinned build for its platform downloads nothing", () =>
  Effect.gen(function* () {
    let downloads = 0;
    const result = yield* installArtifact(
      ChildProcessSpawner.make(() => Effect.die("nothing may run")),
      "Tool",
      artifact,
    ).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.sync(() => downloads++).pipe(Effect.andThen(Effect.die("no"))),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Architecture, "arm64"),
      Effect.provide(NodeServices.layer),
      Effect.result,
    );
    expect(Result.isFailure(result) && result.failure.message).toBe(
      "GOAT has no verified Tool build for darwin arm64.",
    );
    expect(downloads).toBe(0);
  }),
);

it.effect("a download that fails is reported as a failed download, and installs nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { result, spawned, left } = yield* install(release, { status: 404 });
      expect(Result.isFailure(result) && result.failure.message).toBe(
        "GOAT could not download Tool 2026.1.2-abc from downloads.example.test. Nothing was installed.",
      );
      expect(spawned).toEqual([]);
      expect(left).toEqual([]);
    }),
  ),
);

it.effect(
  "a file of someone else's under a link name is left alone, and nothing is installed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { result, left, home, fs, path } = yield* install(release, {
          existing: "tool-alias",
        });
        const at = path.join(home, ".local", "bin", "tool-alias");
        expect(Result.isFailure(result) && result.failure.message).toBe(
          `${at} already exists and is not Tool's. GOAT left it alone and installed nothing.`,
        );
        expect(yield* fs.readFileString(at)).toBe("mine\n");
        expect(left).toEqual([]);
      }),
    ),
);
