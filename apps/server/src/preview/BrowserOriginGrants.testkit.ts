import * as Effect from "effect/Effect";
import { makeBrowserOriginGrants, type Union } from "./BrowserOriginGrants.ts";

const hash = "a".repeat(64);
export const makeTestBrowserOriginGrants = (
  dependencies: Omit<Parameters<typeof makeBrowserOriginGrants>[0], "publish" | "confirm"> & {
    readonly publish: (union: Union) => Effect.Effect<void, Error>;
  },
) =>
  makeBrowserOriginGrants({
    ...dependencies,
    publish: (union) => dependencies.publish(union).pipe(Effect.as(hash)),
    confirm: () =>
      Effect.succeed({
        capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
      }),
  });
