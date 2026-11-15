import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
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
    const crypto = yield* Crypto.Crypto;
    const checksum = Hex.encode(
      yield* crypto.digest("SHA-256", upstreamArchive).pipe(Effect.orDie),
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not install a cached update the manifest has since withdrawn", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const checksum = Hex.encode(
      yield* crypto.digest("SHA-256", upstreamArchive).pipe(Effect.orDie),
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns a managed install the manifest withdraws to the pinned release", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const checksum = Hex.encode(
      yield* crypto.digest("SHA-256", upstreamArchive).pipe(Effect.orDie),
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["update", "reinstall"] as const)(
  "rejects withdrawal during $0 validation",
  (operation) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const checksum = Hex.encode(
        yield* crypto.digest("SHA-256", upstreamArchive).pipe(Effect.orDie),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
