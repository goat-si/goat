// @effect-diagnostics nodeBuiltinImport:off - fixture writes provider transcript files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";

// Registered from UsageService.test.ts, which owns the shared usage fixture.
export function registerAntigravityRemovedProfileTest(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
) {
  it.effect("keeps Antigravity history from a removed instance's GOAT-managed profile", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const prefix = "usage-service-antigravity-removed-profile-test";
      const stateDir = NodePath.join(home, prefix, "userdata");
      const conversations = NodePath.join(
        stateDir,
        "providers",
        "antigravity",
        // sha256("antigravity-2"), a profile whose instance is no longer in providerInstances.
        "97f81140feefaccf1e7435718682af520bf6d1a03bfba6ea2eed5c2cabf8be73",
        "antigravity-acp",
        "conversations",
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(conversations, { recursive: true });
        const db = new NodeSqlite.DatabaseSync(NodePath.join(conversations, "profile.db"));
        try {
          db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
          // Step protobuf: 100 input tokens, 7 output tokens, and 2026-08-01T10:00Z.
          const metadata = new Uint8Array([
            0x4a,
            4,
            0x10,
            100,
            0x18,
            7,
            ...Buffer.from("420608a087b7d306", "hex"),
          ]);
          db.prepare("INSERT INTO steps VALUES (?, ?)").run(0, metadata);
        } finally {
          db.close();
        }
      });
      yield* Effect.gen(function* () {
        assert.notProperty(settings.providerInstances, "antigravity-2");
        const service = yield* UsageService.make;
        const summary = yield* service.readSummary(WINDOW);
        const root = yield* Effect.promise(() => NodeFSP.realpath(conversations));
        assert.strictEqual(
          summary.buckets
            .filter((bucket) => bucket.provider === "antigravity" && bucket.sourcePath === root)
            .reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0),
          7,
        );
      }).pipe(Effect.provide(layerService({ prefix, home, settings })));
    }).pipe(Effect.scoped),
  );
}
