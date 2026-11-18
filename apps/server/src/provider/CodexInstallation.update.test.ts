import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Hex from "effect/encoding/Hex";

import { makeHarness, terminalState } from "./CodexInstallation.testkit.ts";
import * as ModelManifest from "./ModelManifest.ts";

const upstreamVersion = "0.163.0";
const upstreamArchive = Buffer.from(
  "H4sIAAAAAAACA+3WzY7CIBQF4D5Kw1oqtNQmPoh7rKStP9BQdMaYefcBE43T9RQ1nm8B7Q1Jk94cYN3peW026juZDvOqsrzO3nj2yofnUK9KwZKUJREcByet/2TymabuPby29S3/NIz0EIbWDC5u/sXf/PO8EAL5j+G/ew1vuP/TXrp2bpunnf/5KP+syCvkP4bJmg5vlf96JxuVbQej4+efi2qUf17g/h/Hhezl2RzdStmhM5osUz5Lyen+RljGF0XGiK/6H9UoF4pS2rpdCCr7fq/oRtqvTocVSjt77k2nr6vud0vyg6ABAAAAAAAAAAAAAABE8gvVbjvaACgAAA==",
  "base64",
);
const upstreamReleaseUrl = `https://github.com/openai/codex/releases/download/rust-v${upstreamVersion}`;
const upstreamResponses = (checksum: string) => ({
  "https://registry.npmjs.org/@openai/codex/latest": () =>
    Response.json({ version: upstreamVersion }),
  [`${upstreamReleaseUrl}/codex-package_SHA256SUMS`]: () =>
    new Response(
      `${"0".repeat(64)}  codex-package-x86_64-apple-darwin.tar.gz\n${checksum}  codex-package-aarch64-apple-darwin.tar.gz\n`,
    ),
  [`${upstreamReleaseUrl}/codex-package-aarch64-apple-darwin.tar.gz`]: () =>
    new Response(upstreamArchive),
});

it.effect("updates a managed install to OpenAI's newest release and never downgrades it", () =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    const checksum = Hex.encode(
      yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
    );
    const h = yield* makeHarness({ responses: upstreamResponses(checksum) });
    yield* h.installation.checkForUpdate;
    // A fresh install still gets the pinned release.
    expect((yield* h.installation.state).version).toBe("0.156.1");
    yield* h.installation.start;
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "succeeded",
      installedVersion: "0.156.1",
      version: upstreamVersion,
    });

    yield* h.installation.start;
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "succeeded",
      installedVersion: upstreamVersion,
      version: upstreamVersion,
    });
    expect((yield* h.installation.resolve()).version).toBe(upstreamVersion);

    // Without upstream information the older pin is not offered as a reinstall.
    const restarted = yield* makeHarness({ baseDir: h.baseDir });
    expect(yield* restarted.installation.state).toMatchObject({
      installedVersion: upstreamVersion,
      version: upstreamVersion,
    });
    yield* restarted.installation.start;
    expect(yield* terminalState(restarted.installation)).toMatchObject({
      phase: "succeeded",
      installedVersion: upstreamVersion,
    });
    expect(restarted.downloads()).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

/** Counts requests for the upstream archive, the download only an update makes. */
const countedUpstream = (checksum: string) => {
  const counter = { archive: 0 };
  const responses = upstreamResponses(checksum);
  const archiveUrl = `${upstreamReleaseUrl}/codex-package-aarch64-apple-darwin.tar.gz`;
  return {
    counter,
    responses: {
      ...responses,
      [archiveUrl]: () => {
        counter.archive++;
        return new Response(upstreamArchive);
      },
    },
  };
};

it.effect(
  "an OpenCodex child's repair over a broken install never installs a cached newer release",
  () =>
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;
      const checksum = Hex.encode(
        yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
      );
      const { counter, responses } = countedUpstream(checksum);
      const h = yield* makeHarness({ responses });
      yield* h.installation.start;
      yield* terminalState(h.installation);
      yield* h.installation.checkForUpdate;
      expect((yield* h.installation.state).version).toBe(upstreamVersion);
      // The managed runtime's files go missing while active.json still names 0.156.1.
      yield* h.fs.remove(`${h.baseDir}/tools/codex/0.156.1/bin/codex`);
      yield* h.installation.startManagedOnly({ allowUpdate: false });
      yield* terminalState(h.installation);
      expect(counter.archive).toBe(0);
      const active = yield* h.fs.readFileString(`${h.baseDir}/tools/codex/active.json`);
      expect(active).toContain("0.156.1");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("Install on an authless home with a Codex on PATH keeps the newer managed release", () =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    const checksum = Hex.encode(
      yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
    );
    const h = yield* makeHarness({ responses: upstreamResponses(checksum) });
    yield* h.installation.start;
    yield* terminalState(h.installation);
    yield* h.installation.checkForUpdate;
    yield* h.installation.start;
    expect((yield* terminalState(h.installation)).installedVersion).toBe(upstreamVersion);
    const withLocal = yield* makeHarness({ baseDir: h.baseDir, local: { version: "0.164.0" } });
    yield* withLocal.installation.start;
    yield* terminalState(withLocal.installation);
    expect((yield* withLocal.installation.state).source).toBe("local");
    yield* withLocal.installation.startManagedOnly({ allowUpdate: true });
    yield* terminalState(withLocal.installation);
    expect(withLocal.downloads()).toBe(0);
    expect((yield* withLocal.installation.resolve({ managedOnly: true })).version).toBe(
      upstreamVersion,
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("keeps the managed install when an update fails its published checksum", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ responses: upstreamResponses("f".repeat(64)) });
    yield* h.installation.start;
    yield* terminalState(h.installation);
    yield* h.installation.checkForUpdate;
    yield* h.installation.start;
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "failed",
      installedVersion: "0.156.1",
      message: expect.stringContaining("SHA-256"),
    });
    expect((yield* h.installation.resolve()).version).toBe("0.156.1");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("offers no update and keeps the managed install when the checksums are unreachable", () =>
  Effect.gen(function* () {
    let upstreamDownloads = 0;
    const archiveUrl = `${upstreamReleaseUrl}/codex-package-aarch64-apple-darwin.tar.gz`;
    const h = yield* makeHarness({
      responses: {
        ...upstreamResponses("f".repeat(64)),
        [`${upstreamReleaseUrl}/codex-package_SHA256SUMS`]: () =>
          new Response(null, { status: 404 }),
        [archiveUrl]: () => {
          upstreamDownloads++;
          return new Response(upstreamArchive);
        },
      },
    });
    yield* h.installation.start;
    yield* terminalState(h.installation);
    yield* h.installation.checkForUpdate;
    expect((yield* h.installation.state).version).toBe("0.156.1");
    yield* h.installation.start;
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "succeeded",
      installedVersion: "0.156.1",
    });
    expect(upstreamDownloads).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("does not install a cached update the manifest has since withdrawn", () =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    const checksum = Hex.encode(
      yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
    );
    let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
    const h = yield* makeHarness({
      responses: upstreamResponses(checksum),
      manifestCurrent: Effect.sync(() => manifest),
    });
    yield* h.installation.start;
    yield* terminalState(h.installation);
    yield* h.installation.checkForUpdate;
    expect((yield* h.installation.state).version).toBe(upstreamVersion);
    manifest = {
      ...manifest,
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=0.0.42",
          ranges: [
            { range: ">=0.160.0", status: "unsupported" },
            { range: ">=0.156.0 <0.160.0", status: "supported" },
          ],
        },
      ],
    };
    const downloads = h.downloads();
    yield* h.installation.start;
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "succeeded",
      installedVersion: "0.156.1",
      version: "0.156.1",
    });
    expect(h.downloads()).toBe(downloads);
    expect((yield* h.installation.resolve()).version).toBe("0.156.1");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("returns a managed install the manifest withdraws to the pinned release", () =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    const checksum = Hex.encode(
      yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
    );
    let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
    const h = yield* makeHarness({
      responses: upstreamResponses(checksum),
      manifestCurrent: Effect.sync(() => manifest),
    });
    yield* h.installation.checkForUpdate;
    yield* h.installation.start;
    yield* terminalState(h.installation);
    yield* h.installation.start;
    expect(yield* terminalState(h.installation)).toMatchObject({
      installedVersion: upstreamVersion,
    });

    manifest = {
      ...manifest,
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=0.0.42",
          ranges: [
            { range: ">=0.160.0", status: "unsupported" },
            { range: ">=0.156.0 <0.160.0", status: "supported" },
          ],
        },
      ],
    };
    yield* h.installation.checkForUpdate;
    expect(yield* h.installation.state).toMatchObject({
      installedVersion: upstreamVersion,
      version: "0.156.1",
    });
    yield* h.installation.start;
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "succeeded",
      installedVersion: "0.156.1",
      version: "0.156.1",
    });
    expect((yield* h.installation.resolve()).version).toBe("0.156.1");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["update", "reinstall"] as const)(
  "rejects withdrawal during $0 validation",
  (operation) =>
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;
      const checksum = Hex.encode(
        yield* digest.digest(Digest.sha256, upstreamArchive).pipe(Effect.orDie),
      );
      let manifest = ModelManifest.BUNDLED_MODEL_MANIFEST;
      let withdraw = operation === "update";
      const h = yield* makeHarness({
        responses: upstreamResponses(checksum),
        manifestCurrent: Effect.sync(() => manifest),
        options: {
          validate: (_executable, version) =>
            Effect.sync(() => {
              if (withdraw && version === upstreamVersion)
                manifest = {
                  ...ModelManifest.BUNDLED_MODEL_MANIFEST,
                  compatibility: [
                    {
                      driver: "codex",
                      t3CodeRange: ">=0.0.42",
                      ranges: [
                        { range: ">=0.160.0", status: "unsupported" },
                        { range: ">=0.156.0 <0.160.0", status: "supported" },
                      ],
                    },
                  ],
                };
            }),
        },
      });
      yield* h.installation.start;
      yield* terminalState(h.installation);
      yield* h.installation.checkForUpdate;
      if (operation === "reinstall") {
        yield* h.installation.start;
        expect((yield* terminalState(h.installation)).phase).toBe("succeeded");
        withdraw = true;
      }
      yield* h.installation.start;
      expect((yield* terminalState(h.installation)).phase).toBe("failed");
      if (operation === "update") {
        expect((yield* h.installation.resolve()).version).toBe("0.156.1");
      } else {
        expect((yield* h.installation.state).version).toBe("0.156.1");
        yield* Effect.flip(h.installation.resolve());
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
