import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

const MAX_UPLOAD_HOLDERS = 1024;

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
  readonly concurrency:
    | { readonly type: "global"; readonly limit: number }
    | {
        readonly type: "per-environment";
        readonly limit: number;
        readonly environment: (request: Request) => string;
      };
  readonly error: (cause: unknown) => UploadError;
  readonly maxHolders?: number;
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

  if (!Number.isSafeInteger(options.concurrency.limit) || options.concurrency.limit < 1) {
    throw new Error("Upload concurrency limit must be a positive integer.");
  }
  const globalPermits = Semaphore.makeUnsafe(options.concurrency.limit);
  const environmentPermits = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const withPermit = (request: Request, effect: Effect.Effect<string, UploadError>) => {
    if (options.concurrency.type === "global")
      return effect.pipe(Semaphore.withPermits(globalPermits, 1));
    const environment = options.concurrency.environment(request);
    return Effect.suspend(() => {
      let entry = environmentPermits.get(environment);
      if (!entry) {
        entry = { semaphore: Semaphore.makeUnsafe(options.concurrency.limit), users: 0 };
        environmentPermits.set(environment, entry);
      }
      entry.users++;
      const current = entry;
      return effect.pipe(
        Semaphore.withPermits(current.semaphore, 1),
        Effect.ensuring(
          Effect.sync(() => {
            current.users--;
            if (current.users === 0) environmentPermits.delete(environment);
          }),
        ),
      );
    });
  };
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
      Effect.andThen(withPermit(requestFor(key), nativeTransfer(key))),
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
          const fiber = yield* Effect.forkScoped(transfer(key, transfers.get(key.id)), {
            startImmediately: true,
          });
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

  type Holder = { request: Request; scope: Scope.Closeable };
  const maxHolders = options.maxHolders ?? MAX_UPLOAD_HOLDERS;
  if (!Number.isSafeInteger(maxHolders) || maxHolders < 1 || maxHolders > MAX_UPLOAD_HOLDERS) {
    throw new Error("Invalid upload holder limit.");
  }
  let holderCount = 0;
  const holders = new Map<string, Set<Holder>>();
  const synced = new Map<string, () => void>();
  let disposed = false;
  const open = (request: Request) => {
    const holder = Scope.makeUnsafe();
    Effect.runSync(
      Scope.provide(holder)(RcMap.get(uploads, new UploadKey(options.key(request), request))),
    );
    return holder;
  };
  function hold(request: Request): () => void {
    if (disposed) throw new Error("Upload registry is disposed.");
    if (holderCount >= maxHolders) throw new Error("Upload holder limit reached.");
    const id = options.key(request);
    if (!holders.has(id) && running.size >= MAX_UPLOAD_HOLDERS) {
      throw new Error("Upload transfer limit reached.");
    }
    const holder: Holder = { request, scope: open(request) };
    let entries = holders.get(id);
    if (!entries) {
      entries = new Set();
      holders.set(id, entries);
    }
    entries.add(holder);
    holderCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!entries.delete(holder)) return;
      holderCount--;
      if (entries.size === 0) holders.delete(id);
      Effect.runFork(Scope.close(holder.scope, Exit.void));
    };
  }
  function sync(requests: ReadonlyArray<Request>) {
    if (disposed) return;
    const keys = new Map(requests.map((request) => [options.key(request), request]));
    for (const [id, release] of synced) {
      if (!keys.has(id)) {
        synced.delete(id);
        release();
      }
    }
    for (const [id, request] of keys) {
      if (!synced.has(id)) synced.set(id, hold(request));
    }
  }
  function retryFailed(id: string) {
    if (states[id]?.status !== "failed") return;
    Effect.runSync(RcMap.invalidate(uploads, new UploadKey<Request>(id, null)));
    for (const holder of holders.get(id) ?? []) {
      Effect.runFork(Scope.close(holder.scope, Exit.void));
      holder.scope = open(holder.request);
    }
  }

  return {
    sync,
    hold,
    /** Uploads the attachment, joining its running upload when there is one. */
    upload(request: Request): Effect.Effect<string, UploadError> {
      return Effect.suspend(() => {
        if (disposed) return Effect.fail(options.error(new Error("Upload cancelled.")));
        retryFailed(options.key(request));
        return Effect.acquireUseRelease(
          Effect.try({ try: () => hold(request), catch: options.error }),
          () =>
            RcMap.get(uploads, new UploadKey(options.key(request), request)).pipe(
              Effect.flatMap(Fiber.join),
              Effect.scoped,
            ),
          (release) => Effect.sync(release),
        );
      });
    },
    retry: retryFailed,
    async settled(id?: string) {
      if (id !== undefined) {
        const fiber = transfers.get(id);
        if (fiber) await Effect.runPromise(Fiber.await(fiber));
        return;
      }
      while (running.size > 0) {
        await Effect.runPromise(Fiber.awaitAll([...running]));
      }
    },
    dispose() {
      disposed = true;
      for (const entries of holders.values()) {
        for (const holder of entries) Effect.runFork(Scope.close(holder.scope, Exit.void));
        entries.clear();
      }
      holderCount = 0;
      holders.clear();
      synced.clear();
      Effect.runFork(Scope.close(scope, Exit.void));
      states = {};
      options.onChange(states);
    },
  };
}
