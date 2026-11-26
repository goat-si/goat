// @effect-diagnostics nodeBuiltinImport:off - openAsBlob gives the demuxer bounded, file-backed reads.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@goat/contracts";

const unreadable = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "Could not read this attachment as MP4, MOV, WebM or Matroska video.",
  });

export const readAttachmentVideoMetadata = Effect.fn("attachment.videoMetadata")(function* (
  path: string,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const { BlobSource, Input, MATROSKA, MP4, QTFF, WEBM } = await import("mediabunny");
      const blob = await NodeFS.openAsBlob(path);
      signal.throwIfAborted();
      const input = new Input({
        source: new BlobSource(blob),
        formats: [MP4, QTFF, WEBM, MATROSKA],
      });
      const dispose = () => input.dispose();
      signal.addEventListener("abort", dispose, { once: true });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw unreadable();
        const [duration, width, height] = await Promise.all([
          track.computeDuration().catch(() => null),
          track.getDisplayWidth().catch(() => null),
          track.getDisplayHeight().catch(() => null),
        ]);
        return {
          durationMs:
            duration !== null && Number.isFinite(duration) && duration >= 0
              ? Math.round(duration * 1000)
              : null,
          width: width !== null && Number.isSafeInteger(width) && width > 0 ? width : null,
          height: height !== null && Number.isSafeInteger(height) && height > 0 ? height : null,
        };
      } finally {
        signal.removeEventListener("abort", dispose);
        dispose();
      }
    },
    catch: unreadable,
  }).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(unreadable()) }));
});
