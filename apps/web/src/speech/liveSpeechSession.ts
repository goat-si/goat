import {
  uint8ArrayToBase64,
  VOICE_STREAM_MAX_CHUNK_BYTES,
  type SpeechStreamEvent,
  type SpeechStreamFeed,
} from "@goat/contracts";

export interface LiveSpeechTransport {
  readonly start: (locale: string, signal?: AbortSignal) => Promise<{ readonly streamId: string }>;
  readonly subscribe: (
    streamId: string,
    onEvent: (event: SpeechStreamEvent) => void,
    onDisconnect: () => void,
    signal?: AbortSignal,
  ) => Promise<() => void>;
  readonly feed: (input: SpeechStreamFeed, signal?: AbortSignal) => Promise<void>;
  readonly finish: (streamId: string, signal?: AbortSignal) => Promise<void>;
  readonly cancel: (streamId: string) => Promise<void>;
}

export const LIVE_SPEECH_CANCEL_WAIT_MS = 5_000;

export async function startLiveSpeechSession(options: {
  readonly transport: LiveSpeechTransport;
  readonly locale: string;
  readonly canSend: () => boolean;
  readonly onPreview: (text: string) => void;
  readonly onFailure: () => void;
  readonly signal?: AbortSignal;
}) {
  if (!options.canSend() || options.signal?.aborted) return null;
  let streamId: string;
  try {
    ({ streamId } = await options.transport.start(options.locale, options.signal));
  } catch {
    return null;
  }
  let active = true;
  let finishing = false;
  let sequence = 0;
  let revision = -1;
  let inFlight: Promise<void> | null = null;
  let cleanup: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  let resolveFinal: (text: string | null) => void = () => {};
  const final = new Promise<string | null>((resolve) => {
    resolveFinal = resolve;
  });
  const dispose = () => {
    options.signal?.removeEventListener("abort", cancel);
    unsubscribe?.();
    unsubscribe = undefined;
  };
  const cancelRemote = () => {
    if (!options.canSend()) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LIVE_SPEECH_CANCEL_WAIT_MS);
    });
    let request: Promise<void>;
    try {
      request = options.transport.cancel(streamId).catch(() => {});
    } catch {
      request = Promise.resolve();
    }
    return Promise.race([request, deadline]).finally(() => clearTimeout(timer));
  };
  function fail() {
    if (!active) return;
    active = false;
    cleanup = cancelRemote();
    resolveFinal(null);
    dispose();
    options.onFailure();
  }
  function cancel() {
    if (!active) return;
    active = false;
    cleanup = cancelRemote();
    resolveFinal(null);
    dispose();
  }
  const onEvent = (event: SpeechStreamEvent) => {
    if (!active) return;
    if (event.type === "ready") return;
    if (event.type === "error") return fail();
    if (event.type === "final") {
      if (!finishing) return fail();
      active = false;
      resolveFinal(event.text);
      dispose();
      return;
    }
    if (event.revision <= revision) return;
    revision = event.revision;
    options.onPreview(event.committed + event.tentative);
  };
  if (!options.canSend() || options.signal?.aborted) {
    cancel();
    return null;
  }
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    unsubscribe = await options.transport.subscribe(streamId, onEvent, fail, options.signal);
  } catch {
    fail();
    return null;
  }
  if (!active) {
    unsubscribe();
    return null;
  }
  return {
    feed(bytes: Uint8Array) {
      if (!active) return Promise.resolve();
      if (
        !options.canSend() ||
        inFlight ||
        bytes.byteLength === 0 ||
        bytes.byteLength > VOICE_STREAM_MAX_CHUNK_BYTES ||
        bytes.byteLength % 2 !== 0
      ) {
        fail();
        return Promise.resolve();
      }
      const input = { streamId, sequence: sequence++, audioBase64: uint8ArrayToBase64(bytes) };
      const pending = options.transport
        .feed(input, options.signal)
        .catch(fail)
        .finally(() => {
          if (inFlight === pending) inFlight = null;
        });
      inFlight = pending;
      return pending;
    },
    async finish() {
      if (!active) {
        await cleanup;
        return null;
      }
      if (inFlight) await inFlight;
      if (!active || !options.canSend()) {
        fail();
        return null;
      }
      finishing = true;
      try {
        await options.transport.finish(streamId, options.signal);
      } catch {
        fail();
      }
      const text = await final;
      if (text === null) await cleanup;
      return text;
    },
    cancel,
  };
}
