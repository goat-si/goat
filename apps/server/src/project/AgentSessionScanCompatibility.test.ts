import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentSessionScanInput,
  AgentSessionScanResult,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

// Frozen response shape from 215d07e418: the source enum must stay closed in this decoder.
const legacyScanResult = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      projectId: Schema.optional(ProjectId),
      sources: Schema.Array(Schema.Literals(["claudeAgent", "codex"])),
      threadCount: NonNegativeInt,
      lastActiveAt: Schema.NullOr(IsoDateTime),
      alreadyImported: Schema.Boolean,
      git: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            remoteKey: Schema.NullOr(Schema.String),
            repository: Schema.NullOr(Schema.String),
          }),
        ),
      ),
    }),
  ),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
const decodeLegacyScan = Schema.decodeUnknownEffect(legacyScanResult);
const decodeScanRequest = Schema.decodeUnknownEffect(AgentSessionScanInput);
const encodeScanResponse = Schema.encodeEffect(AgentSessionScanResult);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-scan-compatibility-" });
  const shared = path.join(root, "shared");
  const piOnly = path.join(root, "pi-only");
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const piHome = path.join(root, "pi");
  const records = [
    [
      path.join(claudeHome, "projects", "shared", "claude.jsonl"),
      { type: "user", cwd: shared, sessionId: "claude" },
    ],
    [
      path.join(codexHome, "sessions", "2026", "01", "01", "rollout-codex.jsonl"),
      { type: "session_meta", payload: { id: "codex", cwd: shared } },
    ],
    [
      path.join(piHome, "sessions", "shared", "pi.jsonl"),
      { type: "session", id: "pi-shared", cwd: shared },
    ],
    [
      path.join(piHome, "sessions", "pi-only", "pi.jsonl"),
      { type: "session", id: "pi-only", cwd: piOnly },
    ],
  ] as const;
  for (const workspace of [shared, piOnly]) yield* fs.makeDirectory(workspace);
  for (const [file, record] of records) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify(record) + "\n");
  }
  const layer = AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(root, path.join(root, "config")),
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: claudeHome },
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: codexHome },
            },
            [ProviderInstanceId.make("pi")]: {
              driver: ProviderDriverKind.make("pi"),
              enabled: true,
              config: {},
              environment: [
                { name: "PI_CODING_AGENT_DIR", value: piHome, sensitive: false },
                { name: "PI_CODING_AGENT_SESSION_DIR", value: "", sensitive: false },
              ],
            },
          },
        }),
      ),
    ),
  );
  const context = yield* Layer.build(layer);
  const scanner = yield* AgentSessionScanner.AgentSessionScanner.pipe(Effect.provide(context));
  return { scanner, shared, piOnly };
});

it.layer(NodeServices.layer)("scan response compatibility", (it) => {
  it.effect.each([
    { name: "omitted", request: {} },
    { name: "false", request: { includePi: false } },
  ])("older clients decode the scan when includePi is $name", ({ request }) =>
    Effect.gen(function* () {
      const { scanner, shared, piOnly } = yield* fixture;
      const legacy = yield* scanner.scan(yield* decodeScanRequest(request));
      const decoded = yield* decodeLegacyScan(yield* encodeScanResponse(legacy));
      expect(
        decoded.candidates.map(({ path, sources, threadCount }) => ({
          path,
          sources,
          threadCount,
        })),
      ).toEqual([{ path: shared, sources: ["claudeAgent", "codex"], threadCount: 2 }]);
      const optedIn = yield* scanner.scan(yield* decodeScanRequest({ includePi: true }));
      expect(optedIn.candidates.find((candidate) => candidate.path === shared)).toMatchObject({
        sources: ["claudeAgent", "codex", "pi"],
        threadCount: 3,
      });
      expect(optedIn.candidates.find((candidate) => candidate.path === piOnly)).toMatchObject({
        sources: ["pi"],
        threadCount: 1,
      });
      const legacyAgain = yield* scanner.scan(yield* decodeScanRequest(request));
      expect(yield* decodeLegacyScan(yield* encodeScanResponse(legacyAgain))).toEqual(decoded);
    }).pipe(Effect.scoped),
  );
});
