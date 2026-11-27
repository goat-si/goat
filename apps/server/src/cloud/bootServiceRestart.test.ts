import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { makeHarness } from "./bootService.testkit.ts";

it.layer(NodeServices.layer)("restart marker", (it) => {
  it.effect("preserves the tunnel marker across service restarts", () =>
    Effect.gen(function* () {
      const { service, fs, baseDir, makeService, markersAtStop, control } = yield* makeHarness();
      const path = yield* Path.Path;
      const marker = path.join(baseDir, "runtime", "desktop-update-restart");
      yield* service.install();
      yield* service.restart;
      expect(markersAtStop).toEqual([true]);
      expect(yield* fs.exists(marker)).toBe(false);
      const inside = yield* makeService(undefined, "1.2.3", undefined, true);
      control.failCommand = "systemctl --user daemon-reload";
      yield* inside.restart.pipe(Effect.flip);
      expect(yield* fs.exists(marker)).toBe(false);
      control.failCommand = undefined;
      yield* inside.restart;
      expect(markersAtStop).toEqual([true, true]);
      expect(yield* fs.exists(marker)).toBe(true);
    }),
  );
});
