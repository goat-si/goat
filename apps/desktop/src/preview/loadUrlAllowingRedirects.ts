import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

export interface LoadingWebContents {
  on(event: "will-prevent-unload", listener: () => void): unknown;
  off(event: "will-prevent-unload", listener: () => void): unknown;
  loadURL(url: string): Promise<void>;
}

const ERR_ABORTED = -3;

/**
 * Electron rejects loadURL with ERR_ABORTED both when a redirect supersedes the load and when
 * the page blocks its unload; only the blocked unload is a failed navigation.
 */
export const loadUrlAllowingRedirects = <E extends { readonly cause: unknown }, R>(
  webContents: LoadingWebContents,
  url: string,
  attempt: (load: () => Promise<void>) => Effect.Effect<void, E, R>,
) =>
  Effect.suspend(() => {
    let unloadPrevented = false;
    const onPreventUnload = () => {
      unloadPrevented = true;
    };
    return attempt(() => {
      webContents.on("will-prevent-unload", onPreventUnload);
      return webContents.loadURL(url);
    }).pipe(
      Effect.catchIf(
        (error) =>
          !unloadPrevented &&
          Predicate.hasProperty(error.cause, "errno") &&
          error.cause.errno === ERR_ABORTED,
        () => Effect.void,
      ),
      Effect.ensuring(Effect.sync(() => webContents.off("will-prevent-unload", onPreventUnload))),
    );
  });
