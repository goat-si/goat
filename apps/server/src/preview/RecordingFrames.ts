// @effect-diagnostics globalTimers:off - Frames arrive as CDP events outside the Effect runtime.
type Frame = { readonly data: string; readonly width: number; readonly sessionId: number };

// Chromium answers an acknowledgement at once; one still pending this long after the stop never will.
const ACKNOWLEDGE_MS = 1_000;
const stalled = () => new Error("Recording frame acknowledgements are stalled.");

export const makeRecordingFrames = (input: {
  readonly acknowledge: (sessionId: number) => Promise<unknown>;
  readonly encode: (data: string, width: number) => Promise<boolean>;
  readonly stop: () => Promise<unknown>;
  readonly isPrivate: () => boolean;
}) => {
  let pending: Frame | null = null;
  let active: Promise<void> | null = null;
  let failed = false;
  let stopped = false;
  let failure: unknown;
  let stopping: Promise<void> = Promise.resolve();
  const acknowledgements = new Set<Promise<void>>();
  const failureSignal = Promise.withResolvers<void>();
  const fail = (cause: unknown) => {
    if (failed) return;
    failed = true;
    failureSignal.resolve();
    failure = cause;
    pending = null;
    try {
      stopping = input.stop().then(
        () => {},
        (stopError: unknown) => {
          failure = new AggregateError([cause, stopError], "Recording and screencast stop failed.");
        },
      );
    } catch (stopError) {
      failure = new AggregateError([cause, stopError], "Recording and screencast stop failed.");
    }
  };
  const start = () => {
    if (active || failed) return;
    active = Promise.resolve()
      .then(async () => {
        while (pending && !failed) {
          const frame = pending;
          pending = null;
          if (input.isPrivate()) continue;
          if (!(await input.encode(frame.data, frame.width))) {
            pending = null;
            stopped = true;
            await input.stop();
          }
        }
      })
      .catch(fail)
      .finally(() => {
        active = null;
        if (pending && !failed) start();
      });
  };
  return {
    offer(frame: Frame) {
      if (acknowledgements.size >= 32) return fail(stalled());
      try {
        const ack = input
          .acknowledge(frame.sessionId)
          .then(() => {}, fail)
          .finally(() => acknowledgements.delete(ack));
        acknowledgements.add(ack);
      } catch (cause) {
        fail(cause);
      }
      if (failed || stopped || input.isPrivate()) {
        pending = null;
        return;
      }
      pending = frame;
      start();
    },
    async finish() {
      while (active) await active;
      const timer = setTimeout(() => fail(stalled()), ACKNOWLEDGE_MS);
      await Promise.race([Promise.all(acknowledgements), failureSignal.promise]).finally(() =>
        clearTimeout(timer),
      );
      await stopping;
      if (failed) throw failure;
    },
  };
};
