import * as Effect from "effect/Effect";

import { openMediaFile } from "./MediaFile.ts";

/** A guarded response closes its descriptor, so each request opens a fresh one, as the server does. */
export const mediaAsset = (
  path: string,
  guarded: boolean,
  extra: { readonly mimeType: string; readonly expiresAt?: number },
) =>
  Effect.gen(function* () {
    if (!guarded) return { path, ...extra };
    const file = yield* openMediaFile(path);
    if (!file) throw new Error("Expected an opened media file");
    return { path, file, ...extra };
  });
