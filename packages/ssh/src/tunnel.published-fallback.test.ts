import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import {
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
} from "@goat/shared/cliRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  ownRuntimeManifest,
  releaseRuntimeManifest,
  runtimeManifestAssetName,
} from "@goat/shared/runtimeManifest";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import { SshLaunchError } from "./errors.ts";
import { resetPublishedRuntimeIndexCache } from "./runtimePublished.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  ARCHIVE,
  arch,
  commandArgs,
  makeSuccessfulProcess,
  platform,
  uploadTarget,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture, protocolExecutable } from "./tunnel.protocol.fixture.ts";

const PUBLISHED = "1.2.3-nightly.20260910.7";
const platformKey = cliArchivePlatformKey(platform, arch)!;
const asset = cliArchiveFileName(PUBLISHED, platformKey);
const base = cliReleaseDownloadBaseUrl(PUBLISHED);

afterEach(() => {
  vi.unstubAllGlobals();
  resetPublishedRuntimeIndexCache();
});

type Release = "pre-manifest" | "manifest" | "manifest-tampered" | "manifest-newer-protocol";

/**
 * A cold host (nothing installed, nothing running) and a client whose own release cannot be
 * acquired. The stubbed GitHub serves one nightly with a runtime for this platform.
 */
const prepare = (input: {
  release: Release;
  /** The published runtime's own protocol and capability answers. */
  binary?: { ssh?: number; memoryScopes?: boolean; scopeHelpExit?: number; commitTime?: number };
  /** Another client finishes setting the host up just before this one verifies its install. */
  raced?: boolean;
  hostData?: boolean;
  index?: "ok" | "down";
  publishedFallback?: boolean;
  /** Another client writes GOAT data after the host was found empty. */
  dataDuringSearch?: boolean;
  /** Launch the server too, as a connection does. */
  launch?: boolean;
  /** Launch fails after publishing the runner, before the server starts. */
  failStart?: boolean;
}) =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: "1.2.2",
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
    });
    yield* f.fs.remove(f.old, { recursive: true });
    yield* f.fs.remove(`${f.state}/run-t3.sh`);
    if (input.hostData) {
      yield* f.fs.makeDirectory(`${f.home}/.goat/userdata`, { recursive: true });
      yield* f.fs.writeFileString(`${f.home}/.goat/userdata/statev2.sqlite`, "");
    }
    if (input.failStart) yield* f.fs.writeFileString(`${f.test}/fail-pick-port-${PUBLISHED}`, "");
    const stem = asset.replace(/\.tar\.gz$/, "");
    const stage = `${f.home}/published/${stem}`;
    yield* f.fs.makeDirectory(stage, { recursive: true });
    yield* f.fs.writeFileString(
      `${stage}/goat`,
      protocolExecutable(
        PUBLISHED,
        {
          ssh: input.binary?.ssh ?? SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
          drain: true,
          commitTime: input.binary?.commitTime ?? 1_000,
          memoryScopes: input.binary?.memoryScopes ?? true,
          scopeHelpExit: input.binary?.scopeHelpExit ?? 0,
        },
        f.state,
      ),
    );
    yield* f.fs.chmod(`${stage}/goat`, 0o700);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const packed = yield* spawner.spawn(
      ChildProcess.make("tar", ["-czf", `${f.home}/${asset}`, "-C", `${f.home}/published`, stem]),
    );
    assert.equal(Number(yield* packed.exitCode), 0);
    const archive = new Uint8Array(yield* f.fs.readFile(`${f.home}/${asset}`));
    const crypto = yield* Crypto.Crypto;
    const sha = Hex.encode(yield* crypto.digest("SHA-256", archive));
    const manifestName = runtimeManifestAssetName(PUBLISHED);
    const own = ownRuntimeManifest({ version: PUBLISHED, commitTime: 1_000 });
    const manifest = JSON.stringify(
      releaseRuntimeManifest(
        input.release === "manifest-newer-protocol"
          ? { ...own, protocol: { ...own.protocol, ssh: { min: 99_999, max: 99_999 } } }
          : own,
        new Map([[asset, sha]]),
      ),
    );
    const manifestSha = Hex.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(manifest)),
    );
    const withManifest = input.release !== "pre-manifest";
    const sums =
      `${sha}  ${asset}\n` +
      (withManifest
        ? `${input.release === "manifest-tampered" ? "0".repeat(64) : manifestSha}  ${manifestName}\n`
        : "");
    const routes = new Map<string, Uint8Array<ArrayBuffer> | string>([
      [
        cliReleaseIndexPageUrl(1),
        JSON.stringify([
          {
            tag_name: `v${PUBLISHED}`,
            assets: [asset, "SHA256SUMS", ...(withManifest ? [manifestName] : [])].map((name) => ({
              name,
            })),
          },
        ]),
      ],
      [`${base}/SHA256SUMS`, sums],
      [`${base}/${asset}`, archive],
      [`${base}/${manifestName}`, manifest],
    ]);
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      requests.push(String(url));
      const body = routes.get(String(url));
      if (input.index === "down" && String(url).startsWith("https://api.github.com"))
        return new Response(null, { status: 503 });
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    });
    const held = `${f.home}/.goat/runtime/goat/held/${PUBLISHED}`;
    let raceFired = false;
    if (input.raced)
      // The post-install probe is the only probe that runs while this setup holds the version.
      // Just before it, the other client's server is up (its launch cleared the hold).
      f.setBeforeCommand((script) =>
        Effect.gen(function* () {
          if (raceFired || !script.includes('"installedCandidates":[%s]')) return;
          if (!(yield* f.fs.exists(held))) return;
          raceFired = true;
          yield* f.fs.remove(held);
          yield* f.fs.writeFileString(
            `${f.test}/live-tokens-${PUBLISHED}`,
            `live ${PUBLISHED} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} ${process.pid} 1`,
          );
        }),
      );
    // Another client's data lands after this one checked the host was empty, before launch.
    const writeData = f.fs
      .makeDirectory(`${f.home}/.goat/userdata`, { recursive: true })
      .pipe(Effect.andThen(f.fs.writeFileString(`${f.home}/.goat/userdata/statev2.sqlite`, "")));
    const transport = ChildProcessSpawner.make((command) =>
      command._tag === "StandardCommand" && command.command === "gh"
        ? Effect.succeed({
            ...makeSuccessfulProcess("release not found"),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          })
        : input.dataDuringSearch && commandArgs(command).includes("capable")
          ? writeData.pipe(Effect.orDie, Effect.andThen(f.transport.spawn(command)))
          : f.transport.spawn(command),
    );
    const runner = {
      ...f.runner,
      archiveDirectory: `${f.home}/archives`,
      archiveCommitTime: 2_000,
      publishedFallback: input.publishedFallback ?? true,
    };
    const attempt = Effect.result(
      input.launch
        ? SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner).pipe(
            Effect.map((launched) =>
              "selectedRuntime" in launched ? launched.selectedRuntime : (launched as never),
            ),
          )
        : SshTunnel.prepareRemoteRuntime(uploadTarget, {}, runner, REMOTE_RUNTIME_STATE_KEY, true),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, transport));
    const result = yield* attempt;
    const installed = f.fs.exists(
      `${f.home}/.goat/runtime/goat/versions/${PUBLISHED}/.install-complete`,
    );
    return {
      result,
      requests,
      installed: yield* installed,
      uploads: f.counters().uploads,
      fixture: f,
      /** Connects again to the same host, as the next reconnect would. */
      again: Effect.gen(function* () {
        requests.length = 0;
        const next = yield* attempt;
        return { result: next, requests, installed: yield* installed };
      }),
    };
  });

const failureOf = (result: Result.Result<SshTunnel.PreparedRemoteRuntime, unknown>) => {
  assert.isTrue(Result.isFailure(result));
  const failure = Result.isFailure(result) ? result.failure : undefined;
  assert.instanceOf(failure, SshLaunchError);
  return failure as SshLaunchError;
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH published runtime fallback",
  () => {
    it.live.each(["pre-manifest", "manifest"] as const)(
      "installs the newest compatible published runtime on a cold host (%s)",
      (release) =>
        Effect.gen(function* () {
          const { result, requests, installed, uploads } = yield* prepare({ release });
          assert.isTrue(Result.isSuccess(result));
          if (!Result.isSuccess(result)) return;
          const selected = result.success;
          assert.equal(selected.version, PUBLISHED);
          assert.equal(selected.requestedVersion, ARCHIVE.archiveVersion);
          assert.isFalse(selected.mayUpgradeOwnedServer);
          assert.isTrue(installed);
          assert.equal(uploads, 1);
          assert.include(requests, `${base}/${asset}`);
          // Older than this app: the upgrade is deferred and retried.
          assert.equal(selected.upgradeFailure?.reason, "archive_unavailable");
          assert.include(
            selected.upgradeFailure?.fix.instruction ?? "",
            `Using published GOAT ${PUBLISHED}.`,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("does not defer an upgrade when the published runtime is newer than this app", () =>
      Effect.gen(function* () {
        const { result } = yield* prepare({ release: "manifest", binary: { commitTime: 3_000 } });
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) {
          assert.equal(result.success.version, PUBLISHED);
          assert.isUndefined(result.success.upgradeFailure);
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("refuses a manifest that SHA256SUMS does not cover, before downloading", () =>
      Effect.gen(function* () {
        const { result, requests, installed } = yield* prepare({ release: "manifest-tampered" });
        const failure = failureOf(result);
        assert.isFalse(installed);
        assert.notInclude(requests, `${base}/${asset}`);
        assert.equal(failure.reason, "archive-unavailable");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("asks for an app update when published runtimes only speak newer protocols", () =>
      Effect.gen(function* () {
        const { result, installed } = yield* prepare({ release: "manifest-newer-protocol" });
        const failure = failureOf(result);
        assert.isFalse(installed);
        assert.equal(failure.action, "Update this app, then reconnect.");
        assert.equal(
          failure.message,
          `No GOAT runtime for ${platformKey} that works with this app (GOAT ${ARCHIVE.archiveVersion}) could be installed on devbox. Update this app, then reconnect.`,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each([
      ["incompatible protocol", { ssh: 99_999 }],
      ["no memory scopes", { memoryScopes: false }],
    ] as const)(
      "fails closed when an installed pre-manifest runtime has %s, and stays closed",
      ([, binary]) =>
        Effect.gen(function* () {
          const first = yield* prepare({ release: "pre-manifest", binary });
          assert.equal(failureOf(first.result).reason, "archive-unavailable");
          // Stays installed but held, so neither installed-runtime recovery nor the search
          // picks it up on the next connection.
          assert.isTrue(first.installed);
          const second = yield* first.again;
          failureOf(second.result);
          assert.notInclude(second.requests, `${base}/${asset}`);
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a setup that loses a race never rejects the runtime the other client started", () =>
      Effect.gen(function* () {
        const first = yield* prepare({ release: "manifest", raced: true });
        assert.include(failureOf(first.result).message, "at the same time");
        const f = first.fixture;
        assert.isFalse(yield* f.fs.exists(`${f.home}/.goat/runtime/goat/held/${PUBLISHED}`));
        // The other client's server stops; the data it wrote stays.
        yield* f.fs.remove(`${f.test}/live-tokens-${PUBLISHED}`);
        yield* f.fs.makeDirectory(`${f.home}/.goat/userdata`, { recursive: true });
        yield* f.fs.writeFileString(`${f.home}/.goat/userdata/statev2.sqlite`, "");
        const second = yield* first.again;
        assert.isTrue(Result.isSuccess(second.result));
        if (Result.isSuccess(second.result)) assert.equal(second.result.success.version, PUBLISHED);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("does not take scope help from a failing command as evidence of a capability", () =>
      Effect.gen(function* () {
        const { result, fixture: f } = yield* prepare({
          release: "manifest",
          binary: { scopeHelpExit: 1 },
        });
        failureOf(result);
        assert.equal(
          (yield* f.fs.readFileString(`${f.home}/.goat/runtime/goat/held/${PUBLISHED}`)).trim(),
          "rejected",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("a torn hold marker still holds a refused runtime", () =>
      Effect.gen(function* () {
        const first = yield* prepare({ release: "pre-manifest", binary: { memoryScopes: false } });
        failureOf(first.result);
        const f = first.fixture;
        // A write cut short leaves an empty marker; installed-runtime recovery must not take it.
        yield* f.fs.writeFileString(`${f.home}/.goat/runtime/goat/held/${PUBLISHED}`, "");
        const second = yield* first.again;
        failureOf(second.result);
        assert.isTrue(second.installed);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("never puts another build on a host that has GOAT data", () =>
      Effect.gen(function* () {
        const { result, requests, installed } = yield* prepare({
          release: "manifest",
          hostData: true,
        });
        failureOf(result);
        assert.isFalse(installed);
        assert.isFalse(requests.some((url) => url.startsWith("https://api.github.com")));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("names the network when the release index is unreachable, and reads it once", () =>
      Effect.gen(function* () {
        const first = yield* prepare({ release: "manifest", index: "down" });
        assert.equal(
          failureOf(first.result).action,
          "Check that this computer can reach github.com, then reconnect.",
        );
        const second = yield* prepare({ release: "manifest", index: "down" });
        failureOf(second.result);
        assert.isFalse(second.requests.some((url) => url.startsWith("https://api.github.com")));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("launches the published runtime it installed", () =>
      Effect.gen(function* () {
        const { result } = yield* prepare({ release: "manifest", launch: true });
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.equal(result.success.version, PUBLISHED);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("refuses to start it when GOAT data appeared during setup, then and later", () =>
      Effect.gen(function* () {
        const { result, again } = yield* prepare({
          release: "manifest",
          launch: true,
          dataDuringSearch: true,
        });
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.include(String((result.failure as Error).message), "GOAT data appeared");
        // The next connection must not start it through installed-runtime recovery either.
        const next = yield* again;
        assert.isTrue(Result.isFailure(next.result));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live.each(["no data", "data"] as const)(
      "after a failed first start, reconnects to a host with %s: starts it only without data",
      (data) =>
        Effect.gen(function* () {
          const first = yield* prepare({ release: "manifest", launch: true, failStart: true });
          assert.isTrue(Result.isFailure(first.result));
          const f = first.fixture;
          yield* f.fs.remove(`${f.test}/fail-pick-port-${PUBLISHED}`);
          if (data === "data") {
            yield* f.fs.makeDirectory(`${f.home}/.goat/userdata`, { recursive: true });
            yield* f.fs.writeFileString(`${f.home}/.goat/userdata/statev2.sqlite`, "");
          }
          const second = yield* first.again;
          if (data === "data") {
            assert.isTrue(Result.isFailure(second.result));
            if (Result.isFailure(second.result))
              assert.match(
                String((second.result.failure as Error).message),
                /^No GOAT runtime for /,
              );
          } else {
            assert.isTrue(Result.isSuccess(second.result));
            if (Result.isSuccess(second.result))
              assert.equal(second.result.success.version, PUBLISHED);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );

    it.live("leaves acquisition alone unless the runner opts in", () =>
      Effect.gen(function* () {
        const { result, requests } = yield* prepare({
          release: "manifest",
          publishedFallback: false,
        });
        failureOf(result);
        assert.isFalse(requests.some((url) => url.startsWith("https://api.github.com")));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
