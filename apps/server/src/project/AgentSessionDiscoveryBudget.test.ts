// @effect-diagnostics nodeBuiltinImport:off -- test creates dated transcript fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { discoverClaudeHomes } from "./AgentSessionClaudeDiscovery.ts";
import { discoverOtherHomes } from "./AgentSessionOtherDiscovery.ts";
import { makeTempDir, runScan } from "./AgentSessionScanner.testkit.ts";
const claudeSessionLine = (cwd: string) =>
  `${JSON.stringify({ type: "user", cwd, sessionId: "s1" })}\n${JSON.stringify({ type: "assistant" })}\n`;
it.layer(NodeServices.layer)("Claude discovery budget", (it) => {
  it.effect("finds the newest Claude sessions in a large home beside empty ones", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeHomePath = yield* makeTempDir("t3code-claude-large-home-");
      const codexHomePath = yield* makeTempDir("t3code-codex-home-");
      const recentWorkspace = yield* makeTempDir("t3code-workspace-recent-");
      const olderWorkspace = yield* makeTempDir("t3code-workspace-older-");
      // More project folders than the discovery budget reads, in an order unrelated to age.
      const folderCount = 12_000;
      const recentCount = 40;
      const newestMs = Date.parse("2026-03-01T00:00:00.000Z");
      yield* Effect.sync(() => {
        for (let index = 0; index < folderCount; index++) {
          const age = (index * 7_919) % folderCount;
          const directory = path.join(claudeHomePath, "projects", `-slug-${index}`);
          const filePath = path.join(directory, `session-${index}.jsonl`);
          const seconds = (newestMs - age * 60_000) / 1000;
          NodeFS.mkdirSync(directory, { recursive: true });
          NodeFS.writeFileSync(
            filePath,
            claudeSessionLine(age < recentCount ? recentWorkspace : olderWorkspace),
          );
          NodeFS.utimesSync(filePath, seconds, seconds);
          NodeFS.utimesSync(directory, seconds, seconds);
        }
      });
      const emptyHomes = [];
      for (let index = 0; index < 40; index++) {
        emptyHomes.push([
          ProviderInstanceId.make(`claude-empty-${index}`),
          {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: yield* makeTempDir(`t3code-claude-empty-${index}-`) },
          },
        ] as const);
      }

      const result = yield* runScan({
        claudeHomePath,
        codexHomePath,
        providerInstances: Object.fromEntries(emptyHomes),
      });

      expect(
        result.candidates.find((candidate) => candidate.path === recentWorkspace)?.threadCount,
      ).toBe(recentCount);
    }),
  );

  it.effect("passes budget a home frees while rescanning to the homes still short", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeHomePath = yield* makeTempDir("t3code-claude-empty-home-");
      const codexHomePath = yield* makeTempDir("t3code-codex-home-");
      const mediumHomePath = yield* makeTempDir("t3code-claude-medium-home-");
      const largeHomePath = yield* makeTempDir("t3code-claude-large-home-");
      const olderWorkspace = yield* makeTempDir("t3code-workspace-older-");
      const lastWorkspace = yield* makeTempDir("t3code-workspace-last-");
      const newestMs = Date.parse("2026-03-01T00:00:00.000Z");
      // Both homes outgrow their first share; together they fit the source's budget, but only
      // when what the medium home leaves over on its rescan reaches the large one, which is
      // listed first and so needs a second pass.
      yield* Effect.sync(() => {
        const writeSessions = (directory: string, count: number, cwd: string, ageMs: number) => {
          NodeFS.mkdirSync(directory, { recursive: true });
          const seconds = (newestMs - ageMs) / 1000;
          for (let index = 0; index < count; index++) {
            const filePath = path.join(directory, `session-${index}.jsonl`);
            NodeFS.writeFileSync(filePath, claudeSessionLine(cwd));
            NodeFS.utimesSync(filePath, seconds, seconds);
          }
        };
        writeSessions(
          path.join(mediumHomePath, "projects", "-medium"),
          8_000,
          olderWorkspace,
          60_000,
        );
        writeSessions(
          path.join(largeHomePath, "projects", "-bulk"),
          11_000,
          olderWorkspace,
          60_000,
        );
        // Read last because its folder is oldest, yet it holds the newest session.
        const lastDirectory = path.join(largeHomePath, "projects", "-last");
        writeSessions(lastDirectory, 1, lastWorkspace, 0);
        const oldSeconds = (newestMs - 3_600_000) / 1000;
        NodeFS.utimesSync(lastDirectory, oldSeconds, oldSeconds);
      });

      const result = yield* runScan({
        claudeHomePath,
        codexHomePath,
        providerInstances: {
          [ProviderInstanceId.make("claude-large")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: largeHomePath },
          },
          [ProviderInstanceId.make("claude-medium")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: mediumHomePath },
          },
        },
      });

      expect(
        result.candidates.find((candidate) => candidate.path === lastWorkspace)?.threadCount,
      ).toBe(1);
    }),
  );
  it.effect("bounds directory reads and transcript probes across redistributed shares", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* makeTempDir("goat-discovery-budget-");
      const empty = yield* makeTempDir("goat-discovery-empty-");
      const directory = path.join(home, "projects", "one");
      yield* Effect.sync(() => {
        NodeFS.mkdirSync(directory, { recursive: true });
        for (let i = 0; i < 30; i++)
          NodeFS.writeFileSync(path.join(directory, `${i}.jsonl`), claudeSessionLine(home));
      });
      let reads = 0;
      const counted = {
        ...fileSystem,
        readDirectory: (...args: Parameters<typeof fileSystem.readDirectory>) => {
          reads++;
          return fileSystem.readDirectory(...args);
        },
        stat: (target: string) => {
          if (target.endsWith(".jsonl")) reads++;
          return fileSystem.stat(target);
        },
      };
      const result = yield* discoverClaudeHomes({
        fileSystem: counted,
        path,
        homes: [
          { homePath: home, providerInstanceId: ProviderInstanceId.make("claudeAgent") },
          { homePath: empty, providerInstanceId: ProviderInstanceId.make("empty") },
        ],
        operationBudget: 12,
      });
      expect(reads).toBeLessThanOrEqual(12);
      expect(result.transcripts.length).toBeGreaterThan(3);
      expect(result.truncated).toBe(true);
    }),
  );
  it.effect.each(["codex", "pi"] as const)(
    "redistributes unused %s discovery shares without exceeding the operation budget",
    (source) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeTempDir("goat-other-discovery-");
        const empty = yield* makeTempDir("goat-other-empty-");
        const directory =
          source === "codex"
            ? path.join(home, "sessions", "2026", "01", "01")
            : path.join(home, "workspace");
        yield* Effect.sync(() => {
          NodeFS.mkdirSync(directory, { recursive: true });
          for (let i = 0; i < 30; i++)
            NodeFS.writeFileSync(
              path.join(directory, `${source === "codex" ? "rollout-" : ""}${i}.jsonl`),
              "{}",
            );
        });
        let reads = 0;
        const counted = {
          ...fileSystem,
          readDirectory: (...args: Parameters<typeof fileSystem.readDirectory>) => {
            reads++;
            return fileSystem.readDirectory(...args);
          },
          stat: (target: string) => {
            reads++;
            return fileSystem.stat(target);
          },
        };
        const result = yield* discoverOtherHomes({
          source,
          fileSystem: counted,
          path,
          homes: [
            { homePath: home, providerInstanceId: ProviderInstanceId.make(source) },
            { homePath: empty, providerInstanceId: ProviderInstanceId.make("empty") },
          ],
          operationBudget: 12,
        });
        expect(reads).toBeLessThanOrEqual(12);
        expect(result.transcripts.length).toBeGreaterThan(3);
        expect(result.truncated).toBe(true);
      }),
  );
});
