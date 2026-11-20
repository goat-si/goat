import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export type AttachmentUploadState =
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly reason: string };

/** Equal by environment and attachment id; the request rides along for the upload. */
class UploadKey<Request> implements Equal.Equal {
  readonly id: string;
  readonly request: Request | null;
  constructor(id: string, request: Request | null) {
    this.id = id;
    this.request = request;
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof UploadKey && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

function requestFor<Request>(key: UploadKey<Request>): Request {
  if (key.request === null) throw new Error("Upload request is missing.");
  return key.request;
}

/**
 * Every upload of a composer attachment, shared by key: the composer holds the attachments it
 * shows or has queued, and a send joins the upload already running instead of starting another.
 * An upload is interrupted once nothing holds it.
 */
export function createAttachmentUploadRegistry<
  Request,
  UploadError extends { readonly message: string },
>(options: {
  readonly key: (request: Request) => string;
  readonly error: (cause: unknown) => UploadError;
  readonly upload: (
    request: Request,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ) => Promise<string>;
  /** Saves a finished upload's id; the upload is ready once this succeeds. */
  readonly onUploaded?: (request: Request, uploadedId: string) => Effect.Effect<void, UploadError>;
  readonly onChange: (states: Readonly<Record<string, AttachmentUploadState>>) => void;
}) {
  let states: Readonly<Record<string, AttachmentUploadState>> = {};
  function setState(key: string, state: AttachmentUploadState | undefined) {
    const previous = states[key];
    if (
      previous === state ||
      (previous?.status === "uploading" &&
        state?.status === "uploading" &&
        previous.progress === state.progress)
    )
      return;
    const next = { ...states };
    if (state) next[key] = state;
    else delete next[key];
    states = next;
    options.onChange(states);
  }

  const permits = Semaphore.makeUnsafe(3);
  const running = new Set<Fiber.Fiber<string, UploadError>>();
  // The latest transfer per attachment: a re-added attachment waits for an aborted one to settle.
  const transfers = new Map<string, Fiber.Fiber<string, UploadError>>();

  /** The native transfer; interrupting it aborts the request and waits for it to settle. */
  const nativeTransfer = (key: UploadKey<Request>) =>
    Effect.suspend(() => {
      const controller = new AbortController();
      if (states[key.id]?.status !== "uploading") {
        setState(key.id, { status: "uploading", progress: 0 });
      }
      const done = options.upload(requestFor(key), controller.signal, (progress) => {
        if (controller.signal.aborted) return;
        setState(key.id, {
          status: "uploading",
          progress: Math.floor(Math.max(0, Math.min(1, progress)) * 20) / 20,
        });
      });
      return Effect.tryPromise({ try: () => done, catch: options.error }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => controller.abort()).pipe(
            Effect.andThen(Effect.tryPromise({ try: () => done, catch: options.error })),
            Effect.ignore,
          ),
        ),
      );
    });

  const transfer = (key: UploadKey<Request>, previous: Fiber.Fiber<string, unknown> | undefined) =>
    (previous === undefined ? Effect.void : Fiber.await(previous)).pipe(
      Effect.andThen(nativeTransfer(key).pipe(Semaphore.withPermits(permits, 1))),
      Effect.tap((uploadedId) => options.onUploaded?.(requestFor(key), uploadedId) ?? Effect.void),
      Effect.tap(() => Effect.sync(() => setState(key.id, { status: "ready" }))),
      Effect.tapError((error) =>
        Effect.sync(() => setState(key.id, { status: "failed", reason: error.message })),
      ),
    );

  const scope = Scope.makeUnsafe();
  const stateOwners = new Map<string, object>();
  const uploads = Effect.runSync(
    Scope.provide(scope)(
      RcMap.make({
        lookup: Effect.fn("ComposerAttachmentUploads.lookup")(function* (key: UploadKey<Request>) {
          const owner = {};
          stateOwners.set(key.id, owner);
          setState(key.id, { status: "uploading", progress: 0 });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (stateOwners.get(key.id) === owner) {
                stateOwners.delete(key.id);
                setState(key.id, undefined);
              }
            }),
          );
          const fiber = yield* Effect.forkScoped(transfer(key, transfers.get(key.id)));
          transfers.set(key.id, fiber);
          running.add(fiber);
          fiber.addObserver(() => {
            running.delete(fiber);
            if (transfers.get(key.id) === fiber) transfers.delete(key.id);
          });
          return fiber;
        }),
      }),
    ),
  );

  const holders = new Map<string, Scope.Closeable>();
  let requested: ReadonlyArray<Request> = [];
  let disposed = false;
  const release = (id: string) => {
    const holder = holders.get(id);
    if (!holder) return;
    holders.delete(id);
    Effect.runFork(Scope.close(holder, Exit.void));
  };

  /** Holds exactly these uploads; anything no longer requested and held nowhere else stops. */
  function sync(requests: ReadonlyArray<Request>) {
    if (disposed) return;
    requested = requests;
    const keys = new Map(
      requests.map((request) => [new UploadKey(options.key(request), request).id, request]),
    );
    for (const id of holders.keys()) {
      if (!keys.has(id)) release(id);
    }
    for (const [id, request] of keys) {
      if (holders.has(id)) continue;
      const holder = Scope.makeUnsafe();
      holders.set(id, holder);
      Effect.runSync(
        Scope.provide(holder)(RcMap.get(uploads, new UploadKey(options.key(request), request))),
      );
    }
  }

  function retryFailed(id: string) {
    if (states[id]?.status !== "failed") return;
    Effect.runSync(RcMap.invalidate(uploads, new UploadKey<Request>(id, null)));
    release(id);
    sync(requested);
  }

  return {
    sync,
    /** Uploads the attachment, joining its running upload when there is one. */
    upload(request: Request): Effect.Effect<string, UploadError> {
      return Effect.suspend(() => {
        if (disposed) return Effect.fail(options.error(new Error("Upload cancelled.")));
        retryFailed(options.key(request));
        return RcMap.get(uploads, new UploadKey(options.key(request), request)).pipe(
          Effect.flatMap(Fiber.join),
          Effect.scoped,
        );
      });
    },
    retry: retryFailed,
    async settled() {
      while (running.size > 0) {
        await Effect.runPromise(Fiber.awaitAll([...running]));
      }
    },
    dispose() {
      disposed = true;
      holders.clear();
      Effect.runFork(Scope.close(scope, Exit.void));
      states = {};
      options.onChange(states);
    },
  };
}
