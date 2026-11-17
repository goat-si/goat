// Adapted from opencode (MIT). Copyright (c) 2025 opencode. See LICENSE.opencode.
// The engines run in a worker per open file, so no layout, recalculation or painting holds the window. These are the
// two ends of that worker's protocol: typed calls by method name, a key that lets a newer call replace a queued one
// (as the markdown worker's queue does), transferable payloads, and a worker that fails every pending call when it dies.

/** What one method takes and returns. */
export type Method<Input, Output> = { readonly input: Input; readonly output: Output };

/** A worker's methods by name. */
export type Methods = { readonly [name: string]: Method<unknown, unknown> };

type Request = {
  readonly id: number;
  readonly method: string;
  readonly key?: string | undefined;
  readonly input: unknown;
};

/** Withdraws a call whose caller aborted it. */
type Cancel = { readonly cancel: number };

/**
 * The worker waits on a download with its own bound, such as a font, which the call `wait` started. The worker runs one
 * call at a time, so every pending call's deadline pauses until all waits end, even one an aborted call started.
 */
type Wait = { readonly wait: number; readonly waiting: boolean };

/** How long the worker may compute one call, apart from the waits it reports. */
export const callDeadlineMs = 30_000;

type Response =
  /** `transferred` lists the objects the reply moved, so a reply nobody waits for can close its bitmaps. */
  | {
      readonly id: number;
      readonly ok: true;
      readonly value: unknown;
      readonly transferred: readonly Transferable[];
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly superseded: boolean;
      readonly message: string;
    };

/** A value a method returns with the buffers to move to the caller rather than copy. */
export class Transfer<T> {
  constructor(
    readonly value: T,
    readonly transfer: readonly Transferable[],
  ) {}
}

/** A call that a newer call with the same key replaced before it ran. */
export class SupersededError extends Error {}

/** A call made after the worker failed or was closed, or pending when that happened. */
class WorkerClosedError extends Error {}

type CallOptions = {
  /** A newer call with the same key replaces this one while it waits to run. */
  readonly key?: string;
  /** Buffers to move to the worker rather than copy, such as the file's bytes or a transferred canvas. */
  readonly transfer?: readonly Transferable[];
  /** Drops the reply and a call still queued; a call that has started sees its handler's signal abort. */
  readonly signal?: AbortSignal;
};

/** A call waiting for its reply. */
type Pending = {
  readonly settle: (response: Response) => void;
  readonly reject: (error: Error) => void;
  readonly pause: () => void;
  readonly resume: () => void;
};

/** The next call id, why the worker stopped answering once it has, and the calls whose downloads are open. */
type ClientState = { next: number; failure: Error | undefined; readonly waits: Set<number> };

/** The window's end: starts the worker and calls its methods. */
export function createWorkerClient<M extends Methods>(worker: Worker) {
  const pending = new Map<number, Pending>();
  const state: ClientState = { next: 0, failure: undefined, waits: new Set() };

  const fail = (error: Error) => {
    state.failure ??= error;
    pending.forEach((call) => call.reject(error));
    pending.clear();
    worker.terminate();
  };

  worker.addEventListener("message", (event: MessageEvent<Response | Wait>) => {
    if ("wait" in event.data) {
      const before = state.waits.size;

      if (event.data.waiting) state.waits.add(event.data.wait);
      else state.waits.delete(event.data.wait);

      if (before === 0 && state.waits.size > 0) pending.forEach((call) => call.pause());
      if (before > 0 && state.waits.size === 0) pending.forEach((call) => call.resume());

      return;
    }

    const call = pending.get(event.data.id);

    // A reply that crossed its call's cancel on the way: its bitmaps would hold their memory until collected.
    if (!call) {
      if (event.data.ok) closeBitmaps(event.data.transferred);

      return;
    }

    pending.delete(event.data.id);
    call.settle(event.data);
  });

  worker.addEventListener("error", (event) =>
    fail(new WorkerClosedError(event.message || "The Office engine stopped")),
  );
  worker.addEventListener("messageerror", () =>
    fail(new WorkerClosedError("The Office engine sent an unreadable reply")),
  );

  return {
    call<K extends keyof M & string>(
      method: K,
      input: M[K]["input"],
      options: CallOptions = {},
    ): Promise<M[K]["output"]> {
      if (state.failure) return Promise.reject(state.failure);

      if (options.signal?.aborted)
        return Promise.reject(new WorkerClosedError("The call was aborted"));

      const id = ++state.next;

      return new Promise<M[K]["output"]>((resolve, reject) => {
        const expire = () =>
          fail(
            new WorkerClosedError(
              "This document took too long to preview. Open it in another app.",
            ),
          );
        const deadline: { timer: ReturnType<typeof setTimeout> | undefined } = {
          timer: state.waits.size === 0 ? setTimeout(expire, callDeadlineMs) : undefined,
        };
        const abort = () => {
          clearTimeout(deadline.timer);
          pending.delete(id);
          reject(new WorkerClosedError("The call was aborted"));
          worker.postMessage({ cancel: id } satisfies Cancel, []);
        };

        options.signal?.addEventListener("abort", abort, { once: true });
        pending.set(id, {
          settle: (response) => {
            clearTimeout(deadline.timer);
            options.signal?.removeEventListener("abort", abort);

            if (!response.ok)
              return reject(
                response.superseded
                  ? new SupersededError(response.message)
                  : new Error(response.message),
              );

            // SAFETY: the worker answers each id with the output of the method that id called (see `serveWorker`).
            resolve(response.value as M[K]["output"]);
          },
          reject: (error) => {
            clearTimeout(deadline.timer);
            options.signal?.removeEventListener("abort", abort);
            reject(error);
          },
          pause: () => {
            clearTimeout(deadline.timer);
            deadline.timer = undefined;
          },
          resume: () => {
            clearTimeout(deadline.timer);
            deadline.timer = setTimeout(expire, callDeadlineMs);
          },
        });
        worker.postMessage({ id, method, key: options.key, input } satisfies Request, [
          ...(options.transfer ?? []),
        ]);
      });
    },
    /** Stops the worker, which frees its engine's memory, and fails every pending call. */
    close() {
      fail(new WorkerClosedError("The Office engine was closed"));
    },
  };
}

/** Whether a call runs, which call it is, so its caller can abort it, and how many bounded waits each call has open. */
type ServerState = {
  running: boolean;
  current: { readonly id: number; readonly controller: AbortController } | undefined;
  readonly waits: Map<number, number>;
};

/** This worker's server, which `waitOutsideDeadline` reports to. */
const served: { state: ServerState | undefined } = { state: undefined };

/**
 * Awaits work that carries its own bound, such as a font download, while the window pauses the running call's deadline.
 * Outside a served call, as in the window, it is the work itself.
 */
export async function waitOutsideDeadline<T>(work: Promise<T>): Promise<T> {
  const state = served.state;
  const id = state?.current?.id;

  if (!state || id === undefined) return work;

  const open = (state.waits.get(id) ?? 0) + 1;

  state.waits.set(id, open);
  if (open === 1) self.postMessage({ wait: id, waiting: true } satisfies Wait);

  try {
    return await work;
  } finally {
    const left = (state.waits.get(id) ?? 1) - 1;

    if (left > 0) state.waits.set(id, left);
    else {
      state.waits.delete(id);
      self.postMessage({ wait: id, waiting: false } satisfies Wait);
    }
  }
}

/**
 * The worker's end: runs calls one at a time, in order, letting messages through between them. A handler's signal
 * aborts when its caller aborts the call.
 */
export function serveWorker<M extends Methods>(handlers: {
  readonly [K in keyof M]: (
    input: M[K]["input"],
    signal: AbortSignal,
  ) =>
    | M[K]["output"]
    | Transfer<M[K]["output"]>
    | Promise<M[K]["output"] | Transfer<M[K]["output"]>>;
}) {
  const queue: Request[] = [];

  const state: ServerState = { running: false, current: undefined, waits: new Map() };

  served.state = state;

  const reply = (response: Response, transfer: readonly Transferable[] = []) =>
    self.postMessage(response, { transfer: [...transfer] });

  const run = async () => {
    if (state.running) return;

    state.running = true;

    // Each call returns to the event loop before it leaves the queue, so calls that arrived meanwhile can replace it.
    while (queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve));

      const request = queue.shift();

      if (!request) break;

      const handler = handlers[request.method];
      const controller = new AbortController();

      state.current = { id: request.id, controller };

      if (!handler) {
        reply({
          id: request.id,
          ok: false,
          superseded: false,
          message: `Unknown method ${request.method}`,
        });
        continue;
      }

      // SAFETY: the client sends each method the input its `Methods` entry declares (see `createWorkerClient`).
      const input = request.input as never;

      await Promise.resolve()
        .then(() => handler(input, controller.signal))
        .then(
          (result) => {
            const transfer = result instanceof Transfer ? result.transfer : [];

            // The caller already settled a call it aborted, so nothing would take the reply or its bitmaps.
            if (controller.signal.aborted) return closeBitmaps(transfer);

            reply(
              {
                id: request.id,
                ok: true,
                value: result instanceof Transfer ? result.value : result,
                transferred: transfer,
              },
              transfer,
            );
          },
          (cause: unknown) => {
            if (controller.signal.aborted) return;

            reply({
              id: request.id,
              ok: false,
              superseded: false,
              message: cause instanceof Error ? cause.message : String(cause),
            });
          },
        );
    }

    state.running = false;
    state.current = undefined;
  };

  self.addEventListener("message", (event: MessageEvent<Request | Cancel>) => {
    // The caller already settled a cancelled call, so it gets no reply.
    if ("cancel" in event.data) {
      const id = event.data.cancel;
      const queued = queue.findIndex((request) => request.id === id);

      if (queued !== -1) queue.splice(queued, 1);

      if (state.current?.id === id) state.current.controller.abort();

      return;
    }

    const key = event.data.key;
    const replaced = key === undefined ? -1 : queue.findIndex((request) => request.key === key);

    if (replaced !== -1) {
      const [old] = queue.splice(replaced, 1);

      if (old)
        reply({ id: old.id, ok: false, superseded: true, message: "Replaced by a newer call" });
    }

    queue.push(event.data);
    void run();
  });
}

/** Frees the bitmaps among objects that were moved for a reply nobody takes. */
function closeBitmaps(transfer: readonly Transferable[]) {
  transfer.forEach((item) => {
    if (item instanceof ImageBitmap) item.close();
  });
}
