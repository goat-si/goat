import { VoiceTranscriptionUpstreamError } from "@goat/contracts";
import * as Schema from "effect/Schema";

const BUSY_RETRY_DELAY_MS = 250;
const isVoiceTranscriptionUpstreamError = Schema.is(VoiceTranscriptionUpstreamError);

export async function retryBusyTranscription<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      !isVoiceTranscriptionUpstreamError(error) ||
      error.code !== "voice-backend-unavailable" ||
      error.message !== "Speech is busy."
    )
      throw error;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, BUSY_RETRY_DELAY_MS);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return run();
  }
}
