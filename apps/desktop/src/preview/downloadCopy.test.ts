import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { describe, expect } from "vite-plus/test";

import { copyDownload } from "./downloadCopy.ts";

describe("copyDownload", () => {
  it.effect.each([false, true])(
    "keeps simultaneous same-name downloads (existing destination: %s)",
    (existing) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-download-test-" });
        const downloads = path.join(dir, "downloads");
        yield* fs.makeDirectory(downloads);
        if (existing) yield* fs.writeFileString(path.join(downloads, "report.txt"), "existing");
        const sources = [path.join(dir, "first"), path.join(dir, "second")];
        yield* fs.writeFileString(sources[0]!, "first download");
        yield* fs.writeFileString(sources[1]!, "second download");

        // Both downloads pass the existence check before either copy lands, as they do live.
        const raceTarget = path.join(downloads, existing ? "report (1).txt" : "report.txt");
        const probes = yield* Ref.make(0);
        const bothProbed = yield* Deferred.make<void>();
        const exists = (target: string) =>
          Effect.gen(function* () {
            const found = yield* fs.exists(target);
            if (target === raceTarget) {
              if ((yield* Ref.updateAndGet(probes, (count) => count + 1)) === 2) {
                yield* Deferred.succeed(bothProbed, undefined);
              }
              yield* Deferred.await(bothProbed);
            }
            return found;
          });
        const targets: string[] = [];
        const copy = (source: string) =>
          copyDownload({
            fileSystem: { ...fs, exists },
            path,
            directory: downloads,
            source,
            fileName: "report.txt",
            onError: (cause) => cause,
            reveal: (target) => void targets.push(target),
          });
        yield* Effect.all(sources.map(copy), { concurrency: "unbounded" });

        const names = (yield* fs.readDirectory(downloads)).toSorted();
        expect(names).toEqual(
          existing
            ? ["report (1).txt", "report (2).txt", "report.txt"]
            : ["report (1).txt", "report.txt"],
        );
        const contents = yield* Effect.forEach(names, (name) =>
          fs.readFileString(path.join(downloads, name)),
        );
        expect(contents.toSorted()).toEqual(
          (existing
            ? ["existing", "first download", "second download"]
            : ["first download", "second download"]
          ).toSorted(),
        );
        expect(targets).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
