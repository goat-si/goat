// @effect-diagnostics nodeBuiltinImport:off - fixtures write two mounted views.
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { mergeUsage } from "@goat/shared/usageMerge";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";
import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";
import * as Reader from "./usageTranscriptReader.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";

export function registerPhysicalSourceTests(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
  claudeLine: typeof Main.claudeLine,
) {
  it.effect(
    "assigns copies read through partial and complete WSL mounts to the complete source",
    () =>
      Effect.gen(function* () {
        const { home, transcript, settings } = yield* setup;
        const partial = NodePath.join(home, "claude", "projects");
        const secondHome = NodePath.join(home, "second");
        const complete = NodePath.join(secondHome, "projects");
        const blocked = NodePath.join(partial, "unreadable.jsonl");
        const line = claudeLine(1, 5);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(complete, { recursive: true });
          await NodeFSP.writeFile(transcript, line);
          await NodeFSP.writeFile(blocked, line);
          await NodeFSP.writeFile(NodePath.join(complete, "session.jsonl"), line);
        });

        const physicalIdentity = Reader.readPhysicalSourceId;
        using _identity = vi
          .spyOn(Reader, "readPhysicalSourceId")
          .mockImplementation((dir, ...args) =>
            dir === partial || dir === complete
              ? Promise.resolve("same-windows-source")
              : physicalIdentity(dir, ...args),
          );
        const read = Reader.readTranscriptRecords;
        using _transcript = vi
          .spyOn(Reader, "readTranscriptRecords")
          .mockImplementation((filename, ...args) =>
            filename === blocked ? Promise.resolve(null) : read(filename, ...args),
          );

        const raw = yield* UsageService.make.pipe(
          Effect.flatMap((service) => service.readSummary(WINDOW)),
          Effect.provide(
            layerService({
              home,
              prefix: "usage-physical-source-owner",
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("claude-2")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: secondHome },
                  },
                },
              },
              ratesDocument: {
                "claude-fable-5": { input_cost_per_token: 0, output_cost_per_token: 0.2 },
              },
            }),
          ),
        );
        const mounts = raw.sources.filter(
          (source) => source.fingerprint.physicalSourceId !== undefined,
        );
        assert.deepEqual(
          mounts.map((source) => source.status),
          ["partial", "ok"],
        );
        const summary = mergeUsage(
          [{ environmentId: EnvironmentId.make("wsl"), label: "WSL", summary: raw }],
          raw.contractVersion,
        );
        assert.deepEqual([summary.records, summary.costUsd, summary.sessions], [1, 1, 1]);
        assert.strictEqual(raw.buckets[0]?.sourcePath, complete);
      }),
  );
}
