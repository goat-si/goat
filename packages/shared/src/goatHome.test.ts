import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveGoatHome } from "./goatHome.ts";

it.layer(NodeServices.layer)("resolveGoatHome", (it) => {
  const setup = (dirs: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const dir of dirs) yield* fs.makeDirectory(path.join(root, dir), { recursive: true });
      return { root, join: path.join };
    });

  it.effect("defaults to .goat", () =>
    Effect.gen(function* () {
      const { root, join } = yield* setup([]);
      assert.equal(yield* resolveGoatHome(root, "userdata"), join(root, ".goat"));
    }),
  );

  it.effect("keeps using .t3 while it alone holds the state this run reads", () =>
    Effect.gen(function* () {
      const { root, join } = yield* setup([".t3/userdata", ".goat/desktop", ".goat/dev"]);
      assert.equal(yield* resolveGoatHome(root, "userdata"), join(root, ".t3"));
      assert.equal(yield* resolveGoatHome(root, "dev"), join(root, ".goat"));
    }),
  );

  it.effect("prefers .goat once it holds that state", () =>
    Effect.gen(function* () {
      const { root, join } = yield* setup([".t3/userdata", ".goat/userdata"]);
      assert.equal(yield* resolveGoatHome(root, "userdata"), join(root, ".goat"));
    }),
  );
});
