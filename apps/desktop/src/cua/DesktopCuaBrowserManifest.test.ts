// @effect-diagnostics nodeBuiltinImport:off -- The test verifies the real temporary manifest bytes.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { DesktopCuaManifestRequest } from "@goat/contracts";
import * as DesktopManifest from "./DesktopCuaManifest.ts";

const decodeRequest = Schema.decodeUnknownSync(DesktopCuaManifestRequest);

it.effect(
  "publishes the requested union through the desktop channel and replies with its hash",
  () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const replies: unknown[] = [];
      const request = {
        requestId: "request:1",
        union: { existingProfiles: [{ pid: 12, windowId: 34 }], origins: ["https://example.test"] },
      };
      const handler = DesktopManifest.makeBrowserManifestRequestHandler({
        path: () => "/desktop/capability-manifest.yaml",
        publish: (path: string, union: unknown) =>
          Effect.sync(() => {
            calls.push({ path, union });
            return "a".repeat(64);
          }),
      });
      yield* handler({
        request,
        reply: (result: unknown) =>
          Effect.sync(() => {
            replies.push(result);
          }),
      });
      expect(calls).toEqual([{ path: "/desktop/capability-manifest.yaml", union: request.union }]);
      expect(replies).toEqual([{ requestId: "request:1", sha256: "a".repeat(64) }]);
    }),
);

it.live("writes the manifest and returns its hash through the desktop request stream", () =>
  Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import("node:fs/promises"));
    const os = yield* Effect.promise(() => import("node:os"));
    const path = yield* Effect.promise(() => import("node:path"));
    const crypto = yield* Effect.promise(() => import("node:crypto"));
    const manifest = yield* Effect.promise(() => import("@goat/shared/cuaDriverManifest"));
    const done = yield* Deferred.make<import("@goat/contracts").DesktopCuaManifestReport>();
    const dir = yield* Effect.promise(() =>
      fs.mkdtemp(path.join(os.tmpdir(), "goat-desktop-manifest-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
    );
    const name = path.join(dir, "capability-manifest.yaml");
    yield* Effect.promise(() =>
      fs.writeFile(name, manifest.cuaDriverCapabilityManifest({ applications: ["editor"] })),
    );
    const request = decodeRequest({
      version: 1,
      type: "cuaManifestRequest",
      requestId: "request:1",
      union: { existingProfiles: [{ pid: 12, windowId: 34 }], origins: ["https://example.test"] },
    });
    const mutex = yield* Semaphore.make(1);
    yield* DesktopManifest.listenBrowserManifestRequests(
      Stream.make({
        request,
        isCurrent: () => true,
        reply: (report: import("@goat/contracts").DesktopCuaManifestReport) =>
          Deferred.succeed(done, report).pipe(Effect.asVoid),
      }),
      () => name,
      mutex,
    );
    const report = yield* Deferred.await(done);
    expect(report.status).toBe("written");
    if (report.status === "written")
      expect(report.sha256).toBe(
        crypto
          .createHash("sha256")
          .update(yield* Effect.promise(() => fs.readFile(name)))
          .digest("hex"),
      );
    expect(yield* Effect.promise(() => fs.readFile(name, "utf8"))).toContain(
      "      - pid: 12\n        window_id: 34",
    );
  }).pipe(Effect.scoped),
);
