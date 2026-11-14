// @effect-diagnostics nodeBuiltinImport:off - fixture writes provider transcript files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Registered from UsageService.test.ts, which owns the shared usage fixture.
export function registerPiHistoryTest(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
) {
  it.effect("discovers Pi history in its default home and directory overrides", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      for (const [agentDir, sessionDir, relativeDir] of [
        [undefined, undefined, ".pi/agent/sessions"],
        ["~/custom-pi", undefined, "custom-pi/sessions"],
        ["~/ignored-pi", "~/custom-sessions", "custom-sessions"],
        ["~/ignored-pi", NodePath.join(home, "absolute-sessions"), "absolute-sessions"],
      ] as const) {
        const dir = NodePath.join(home, relativeDir);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              { type: "session", id: relativeDir },
              {
                type: "usage",
                id: "warm",
                timestamp: "2026-08-01T10:00:00Z",
                provider: "openai",
                model: "model",
                usage: { input: 7 },
              },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const summary = yield* service.readSummary(WINDOW);
          const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
          assert.strictEqual(pi.length, 1);
          assert.strictEqual(pi[0]?.totals.uncachedInputTokens, 7);
          assert.strictEqual(
            summary.sources.find((source) => source.fingerprint.provider === "pi")?.fingerprint
              .resolvedHomePath,
            dir,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-pi-" + relativeDir.replaceAll("/", "-"),
              home,
              settings,
              environment: {
                PI_CODING_AGENT_DIR: agentDir,
                PI_CODING_AGENT_SESSION_DIR: sessionDir,
              },
            }),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      }
    }).pipe(Effect.scoped),
  );
}
