import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { ProviderInstanceId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { resolveAntigravityInstanceDirectories } from "../antigravityAuthSupport.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";

const hostLayer = TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer));
const layer = AntigravityUsage.layer.pipe(Layer.provideMerge(hostLayer));

it.layer(layer)("Antigravity usage", (it) => {
  it.effect("reads history from an unconfigured default instance's managed profile", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const id = ProviderInstanceId.make("antigravity");
      const directories = yield* resolveAntigravityInstanceDirectories(host.paths.stateDir, id);
      const conversations = path.join(directories.profile, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const db = new NodeSqlite.DatabaseSync(path.join(conversations, "profile.db"));
      db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
      db.prepare("INSERT INTO steps VALUES (?, ?)").run(
        0,
        new Uint8Array([0x4a, 4, 0x10, 100, 0x18, 7, ...Buffer.from("420608a087b7d306", "hex")]),
      );
      db.close();
      const usage = yield* AntigravityUsage.AntigravityUsage;
      const scans = yield* usage.scan({
        instances: [
          {
            instanceId: id,
            config: undefined,
            environment: { ANTIGRAVITY_DATA_DIR: path.join(host.paths.baseDir, "none") },
            configured: false,
          },
        ],
        windowStartMs: 0,
      });
      const records = scans.flatMap((scan) => scan.files ?? []).flatMap((file) => file.records);
      assert.strictEqual(
        records.reduce((total, record) => total + record.totals.outputTokens, 0),
        7,
      );
    }),
  );
});
