import {
  type EnvironmentId,
  type MemoryChangeSignal,
  type MemoryId,
  type MemoryItem,
  type MemoryRevisionId,
  type MemorySpaceId,
  WS_METHODS,
  supportsMemoryProtocol,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { createMemoryImportWorkflow } from "../memoryImportWorkflow.ts";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  subscribeMemoryChanges,
  requestMemoryQuery,
  type MemoryBodyRpcTag,
  type EnvironmentRpcInput,
  type EnvironmentUnaryRpcTag,
  type EnvironmentRpcSuccess,
} from "../rpc/client.ts";
import { createEnvironmentCatalogAtoms } from "./connections.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import {
  createEnvironmentRpcCommand,
  environmentRpcKey,
  followStreamInEnvironment,
} from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

export interface MemoryExposure {
  readonly ready: boolean;
  readonly connection: object | null;
  readonly epoch: object;
  readonly versions: HashMap.HashMap<MemoryId, symbol>;
  readonly forgotten: ReadonlySet<MemoryId>;
  readonly forgetGeneration: object;
}

/** Body-free state. Epoch identity also fences replies from a prior subscription. */
export function emptyMemoryExposure(): MemoryExposure {
  return {
    ready: false,
    connection: null,
    epoch: {},
    versions: HashMap.empty(),
    forgotten: new Set(),
    forgetGeneration: {},
  };
}

export function applyMemoryChange(
  state: MemoryExposure,
  signal: MemoryChangeSignal,
): MemoryExposure {
  if (signal.kind === "reset") {
    return { ...state, ready: true, epoch: {}, versions: HashMap.empty() };
  }
  // A fresh symbol per signal: HashMap.set keeps a structurally equal value, so {} never changes.
  const versions = HashMap.set(state.versions, signal.memoryId, Symbol("memory version"));
  // The factory ledger already contains forget IDs. Standalone reducer callers
  // get an immutable snapshot without copying on ordinary upserts/invalidation.
  const forgotten =
    signal.kind === "forget" && !state.forgotten.has(signal.memoryId)
      ? new Set([...state.forgotten, signal.memoryId])
      : state.forgotten;
  return {
    ...state,
    versions,
    forgotten,
    // The factory mutates its ledger before this reducer runs. Set identity cannot
    // signal admission changes for already displayed derived bodies or drafts.
    forgetGeneration: signal.kind === "forget" ? {} : state.forgetGeneration,
  };
}

/** A later upsert/watermark cannot undo a tombstone observed by this consumer. */
export function memoryExposureMatches(
  before: MemoryExposure,
  after: MemoryExposure,
  memoryIds: ReadonlyArray<MemoryId>,
): boolean {
  return (
    before.ready &&
    after.ready &&
    before.epoch === after.epoch &&
    memoryIds.every(
      (id) =>
        !after.forgotten.has(id) &&
        Option.getOrUndefined(HashMap.get(before.versions, id)) ===
          Option.getOrUndefined(HashMap.get(after.versions, id)),
    )
  );
}

/** Why a direct body for memoryId may be empty now, given the exposure seen while it was visible. */
export type MemoryBodyGap = "unchanged" | "changed" | "forgotten" | "unavailable";
export function memoryBodyGap(
  seen: MemoryExposure,
  now: MemoryExposure,
  memoryId: MemoryId,
): MemoryBodyGap {
  if (!seen.ready || !now.ready || seen.epoch !== now.epoch) return "unavailable";
  if (now.forgotten.has(memoryId) || seen.forgetGeneration !== now.forgetGeneration)
    return "forgotten";
  // Includes privacy-hold invalidations (pending forget, scanner hold, forgotten source, hub
  // entries), so "changed" is never a reason to keep a draft.
  if (
    Option.getOrUndefined(HashMap.get(seen.versions, memoryId)) !==
    Option.getOrUndefined(HashMap.get(now.versions, memoryId))
  )
    return "changed";
  return "unchanged";
}

/**
 * What a reread after a change signal shows of the revision an edit started from: still visible
 * ("same"), held only while this device re-scans that revision ("rescanning", how the hub's
 * confirmation of this device's own save lands), or anything else ("other").
 */
function rereadOfRevision(
  value: MemoryItem,
  revisionId: MemoryRevisionId,
): "same" | "rescanning" | "other" {
  if (value.status === "active")
    return value.localAvailability.exposure === "visible" &&
      value.revision.revisionId === revisionId
      ? "same"
      : "other";
  const { reasons, deferred } = value.localAvailability;
  return value.status === "blocked" &&
    reasons.length === 1 &&
    reasons[0] === "scanner_pending" &&
    deferred.some((d) => d.kind === "scanner") &&
    deferred.every(
      (d) => (d.kind === "scanner" || d.kind === "index") && d.revisionId === revisionId,
    )
    ? "rescanning"
    : "other";
}

function containsForgottenMemory(value: unknown, forgotten: ReadonlySet<MemoryId>): boolean {
  if (typeof value !== "object" || value === null) return false;
  // Tombstones are body-free records and remain visible consistently across devices.
  if ("status" in value && value.status === "forgotten") return false;
  // Change signals identify memories, not revisions. Without a complete revision-to-memory
  // map, a derived body cannot be proven independent of a remembered forget. Never infer
  // safety from the absence of its source memory on this particular page.
  if (
    forgotten.size > 0 &&
    "derivedFromMemoryRevisions" in value &&
    Array.isArray(value.derivedFromMemoryRevisions) &&
    value.derivedFromMemoryRevisions.length > 0
  )
    return true;
  if (
    "memoryId" in value &&
    typeof value.memoryId === "string" &&
    forgotten.has(value.memoryId as MemoryId)
  )
    return true;
  return Object.values(value).some((nested) => containsForgottenMemory(nested, forgotten));
}

interface MemoryTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly memorySpaceId: MemorySpaceId };
}

// Bodies are ephemeral, including source text and snippets. Expiry removes the displayed
// value; a consumer must explicitly refresh to request it again. The one exception is a draft
// the person has changed: drafts have no TTL, so an edited draft outlives its body's expiry.
const BODY_TTL = "1 minute";

/** Body-free ledger owned by the factory, independent of weak atom-family lifetimes.
 * Catalog absence can be transient; only owner disposal releases metadata. Capacity never
 * evicts a tombstone: overflow stays closed, even on reset (reset carries no tombstones).
 * A new runtime must acquire a fresh reset before it can expose bodies again.
 */
export function createMemoryTombstoneLedger(maxSpaces = 256, maxIdsPerSpace = 10_000) {
  const spaces = new Map<
    string,
    { environmentId: EnvironmentId; forgotten: Set<MemoryId>; blocked: boolean }
  >();
  const overflow = { forgotten: new Set<MemoryId>(), blocked: true };
  let disposed = false;
  return {
    space(environmentId: EnvironmentId, memorySpaceId: MemorySpaceId) {
      if (disposed) return overflow;
      const key = JSON.stringify([environmentId, memorySpaceId]);
      const retained = spaces.get(key);
      if (retained) return retained;
      if (spaces.size >= maxSpaces) return overflow;
      const ledger = { environmentId, forgotten: new Set<MemoryId>(), blocked: false };
      spaces.set(key, ledger);
      return ledger;
    },
    forget(ledger: { forgotten: Set<MemoryId>; blocked: boolean }, id: MemoryId) {
      if (ledger.forgotten.has(id)) return;
      if (ledger.forgotten.size >= maxIdsPerSpace) ledger.blocked = true;
      else ledger.forgotten.add(id);
    },
    dispose() {
      disposed = true;
      spaces.clear();
    },
  };
}

export function createMemoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  ledger = createMemoryTombstoneLedger(),
) {
  const disposedAtom = Atom.make(false);
  const sessions = createEnvironmentSessionAtoms(runtime);
  const { catalogValueAtom } = createEnvironmentCatalogAtoms(runtime);
  const readPermissions = createCommandPermissions(runtime, WS_METHODS.memoryRead);
  const exposureFamily = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as [EnvironmentId, MemoryTarget["input"]];
    const retained = () => ledger.space(environmentId, input.memorySpaceId);
    const closedState = (): MemoryExposure => ({
      ...emptyMemoryExposure(),
      forgotten: retained().forgotten,
    });
    const unavailable = emptyMemoryExposure();
    const streamAtom = runtime
      .atom((get) => {
        const allowed = get(readPermissions.permissionAtom(environmentId));
        const prepared = get(sessions.preparedConnectionValueAtom(environmentId));
        const config = get(sessions.initialConfigValueAtom(environmentId));
        const entries = get(catalogValueAtom).entries;
        if (get(disposedAtom) || !entries.get(environmentId)?.enabled) {
          return Stream.succeed(emptyMemoryExposure());
        }
        if (
          !allowed ||
          Option.isNone(prepared) ||
          !config ||
          !supportsMemoryProtocol(config.environment.capabilities)
        ) {
          return Stream.succeed(closedState());
        }
        return followStreamInEnvironment(
          environmentId,
          Stream.unwrap(
            EnvironmentSupervisor.pipe(
              Effect.map((supervisor) =>
                SubscriptionRef.changes(supervisor.session).pipe(
                  Stream.switchMap((session) => {
                    const closed = closedState();
                    const stamp = (state: MemoryExposure) => ({ state, producer: session });
                    if (Option.isNone(session)) return Stream.succeed(stamp(closed));
                    return subscribeMemoryChanges(runtime, get.registry, session.value, input).pipe(
                      Stream.filterEffect(() =>
                        SubscriptionRef.get(supervisor.session).pipe(
                          Effect.map((active) => active === session),
                        ),
                      ),
                      Stream.scan(
                        () => closed,
                        (state, signal) => {
                          const current = retained();
                          if (signal.kind === "forget") ledger.forget(current, signal.memoryId);
                          if (current.blocked) return closedState();
                          const next = applyMemoryChange(state, signal);
                          // Version metadata also has a bound. A reset clears it safely
                          // because epoch identity invalidates every pending body/draft.
                          return HashMap.size(next.versions) > 10_000 ? closedState() : next;
                        },
                      ),
                      Stream.catchCause(() => Stream.succeed(closedState())),
                      (stream) => Stream.concat(Stream.succeed(closed), stream),
                      Stream.map(stamp),
                    );
                  }),
                  // switchMap may leave an already buffered old value downstream.
                  Stream.filterEffect(({ producer }) =>
                    SubscriptionRef.get(supervisor.session).pipe(
                      Effect.map((active) => active === producer),
                    ),
                  ),
                  Stream.map(({ state }) => state),
                ),
              ),
            ),
          ),
        ).pipe(Stream.map((state) => ({ ...state, connection: prepared.value })));
      })
      .pipe(Atom.setIdleTTL(0));
    return Atom.make((get) => {
      const connection = get(sessions.preparedConnectionValueAtom(environmentId));
      const allowed = get(readPermissions.permissionAtom(environmentId));
      const registered = get(catalogValueAtom).entries.get(environmentId)?.enabled;
      const result = get(streamAtom);
      // Stream atoms remain waiting while live. Match the connection identity
      // instead of treating that flag as a pending unary request.
      return !get(disposedAtom) &&
        allowed &&
        registered &&
        Option.isSome(connection) &&
        result._tag === "Success" &&
        result.value.connection === connection.value
        ? result.value
        : unavailable;
    }).pipe(Atom.setIdleTTL(0));
  });
  const exposureAtom = (target: MemoryTarget) => exposureFamily(environmentRpcKey(target));

  function command<T extends EnvironmentUnaryRpcTag>(tag: T) {
    const result = createEnvironmentRpcCommand(runtime, { label: `memory:${tag}`, tag });
    const availability = Atom.family((environmentId: EnvironmentId | null) =>
      Atom.make((get) => {
        if (
          get(disposedAtom) ||
          environmentId === null ||
          !get(catalogValueAtom).entries.get(environmentId)?.enabled ||
          !get(result.permissionAtom(environmentId))
        )
          return false;
        const config = get(sessions.initialConfigValueAtom(environmentId));
        return (
          Option.isSome(get(sessions.preparedConnectionValueAtom(environmentId))) &&
          config !== null &&
          supportsMemoryProtocol(config.environment.capabilities) &&
          ((tag !== WS_METHODS.memoryHubDiagnostics && tag !== WS_METHODS.memoryHubReconcile) ||
            config.environment.capabilities.memory?.hubDiagnostics === true) &&
          ((tag !== WS_METHODS.siteNotesList &&
            tag !== WS_METHODS.siteNotesWrite &&
            tag !== WS_METHODS.siteNotesDelete &&
            tag !== WS_METHODS.siteNotesRestoreSeed) ||
            config.environment.capabilities.memory?.siteNotes === true) &&
          (tag !== WS_METHODS.memoryImportProvider ||
            config.environment.capabilities.memory?.importProvider === true)
        );
      }),
    );
    return {
      ...result,
      permissionAtom: (environmentId: EnvironmentId | null, _input?: EnvironmentRpcInput<T>) =>
        availability(environmentId),
    };
  }

  function bodyQuery<T extends MemoryBodyRpcTag>(tag: T) {
    const read = command(tag);
    type Reply = Option.Option<EnvironmentRpcSuccess<T>> | null;
    // Atom.family holds its values weakly, so the family returns the read atom itself and the
    // reply finds its request through it: a wrapper object would be collected and rebuilt with a
    // second request while the read and reply taken out of it are still in use.
    const replies = new WeakMap<object, (get: Atom.AtomContext) => Reply>();
    const family = Atom.family((key: string) => {
      const [environmentId, input] = JSON.parse(key) as [
        EnvironmentId,
        EnvironmentRpcInput<T> & {
          readonly memorySpaceId: MemorySpaceId;
          readonly memoryId?: MemoryId;
        },
      ];
      const state = exposureAtom({ environmentId, input: { memorySpaceId: input.memorySpaceId } });
      const ids = input.memoryId === undefined ? [] : [input.memoryId];
      // Direct ID queries subscribe to a stable projection, not every space signal.
      let selected = emptyMemoryExposure();
      const relevantState = Atom.make((get) => {
        const current = get(state);
        if (ids.length > 0 && memoryExposureMatches(selected, current, ids)) return selected;
        selected = current;
        return current;
      }).pipe(Atom.setIdleTTL(0));
      const raw = runtime
        .atom((get) => {
          const before = get(relevantState);
          // The stable ID projection may retain a pre-forget generation. Capture
          // admission at request start without subscribing the RPC to space changes.
          const forgetGeneration = get.once(state).forgetGeneration;
          const permitted = get(read.permissionAtom(environmentId, input));
          if (!permitted || !memoryExposureMatches(before, before, ids)) {
            return Stream.succeed({
              before,
              forgetGeneration,
              settled: true,
              value: Option.none<EnvironmentRpcSuccess<T>>(),
            });
          }
          const config = get(sessions.initialConfigValueAtom(environmentId));
          // Strip caller hints as well: legacy servers reject unknown strict input keys.
          const { includeRefusedReverts: _hint, ...legacyInput } = input as typeof input & {
            readonly includeRefusedReverts?: true;
          };
          const requestInput =
            tag === WS_METHODS.memoryHistory
              ? ({
                  ...legacyInput,
                  ...(config?.environment.capabilities.memory?.refusedReverts === true
                    ? { includeRefusedReverts: true as const }
                    : {}),
                } as typeof input)
              : input;
          return Stream.fromEffect(
            requestMemoryQuery(runtime, get.registry, environmentId, tag, requestInput).pipe(
              Effect.timeoutOption(BODY_TTL),
            ),
          ).pipe(
            Stream.map((value) => ({ before, forgetGeneration, settled: true, value })),
            (stream) =>
              Stream.concat(
                Stream.succeed({
                  before,
                  forgetGeneration,
                  settled: false,
                  value: Option.none<EnvironmentRpcSuccess<T>>(),
                }),
                stream,
              ),
            Stream.concat(
              Stream.fromEffect(Effect.sleep(BODY_TTL)).pipe(
                Stream.map(() => ({
                  before,
                  forgetGeneration,
                  settled: true,
                  value: Option.none(),
                })),
              ),
            ),
          );
        })
        .pipe(Atom.setIdleTTL(0));
      const readable = Atom.readable(
        (get) => {
          const current = get(relevantState);
          // Admission observes all space changes independently of the stable direct-ID
          // request projection. A source forget must hide an already displayed derivative.
          const admission = get(state);
          const allowed = get(read.permissionAtom(environmentId, input));
          const result = get(raw);
          if (allowed && current.ready && result._tag === "Failure")
            return AsyncResult.map(result, () => Option.none<EnvironmentRpcSuccess<T>>());
          if (
            !allowed ||
            result._tag !== "Success" ||
            // Page/search output is invalidated by any body-free signal.
            result.value.before !== current ||
            // Empty dependencies do not prove independence: a summary can inherit
            // text from parents. Fence every open direct body, including lineage-free
            // history judgments and source pages, on a same-space forget.
            (ids.length > 0 && result.value.forgetGeneration !== admission.forgetGeneration)
          )
            return AsyncResult.success(Option.none<EnvironmentRpcSuccess<T>>());
          if (
            Option.isSome(result.value.value) &&
            containsForgottenMemory(result.value.value.value, admission.forgotten)
          ) {
            const value = result.value.value.value;
            // A tombstone in a page must not hide unrelated memories. Drop affected
            // entries, including derived text, while keeping the response epoch fence.
            if (
              typeof value === "object" &&
              value !== null &&
              "items" in value &&
              Array.isArray(value.items)
            ) {
              return AsyncResult.success(
                Option.some({
                  ...value,
                  items: value.items.filter(
                    (item) => !containsForgottenMemory(item, admission.forgotten),
                  ),
                } as EnvironmentRpcSuccess<T>),
              );
            }
            return AsyncResult.success(Option.none<EnvironmentRpcSuccess<T>>());
          }
          return AsyncResult.success(result.value.value);
        },
        (refresh) => refresh(raw),
      ).pipe(Atom.setIdleTTL(0));
      // The admitted reply of the request for the current exposure, or null while it is pending.
      replies.set(readable, (get): Reply => {
        const value = get(readable);
        const result = get(raw);
        if (value._tag === "Failure") return Option.none<EnvironmentRpcSuccess<T>>();
        return value._tag === "Success" &&
          result._tag === "Success" &&
          result.value.before === get(relevantState) &&
          result.value.settled
          ? value.value
          : null;
      });
      return readable;
    });
    // The reply holds its read atom, so the read stays the family's value while a reply is in use.
    const replyFamily = Atom.family((key: string) => {
      const readable = family(key);
      const reply = replies.get(readable);
      if (reply === undefined) throw new Error("A memory read atom has no reply.");
      return Atom.make((get) => reply(get)).pipe(Atom.setIdleTTL(0));
    });
    type Target = { readonly environmentId: EnvironmentId; readonly input: EnvironmentRpcInput<T> };
    return Object.assign((target: Target) => family(environmentRpcKey(target)), {
      reply: (target: Target) => replyFamily(environmentRpcKey(target)),
    });
  }
  const read = bodyQuery(WS_METHODS.memoryRead);

  const drafts = Atom.family((key: string) => {
    const [environmentId, input, draftId] = JSON.parse(key) as [
      EnvironmentId,
      MemoryTarget["input"],
      string,
    ];
    const state = exposureAtom({ environmentId, input });
    const stored = Atom.make<{
      readonly text: string;
      readonly memoryIds: ReadonlyArray<MemoryId>;
      /** Exposure, revision and text the edit started from; typing keeps them. */
      readonly exposure: MemoryExposure;
      readonly start: { readonly revisionId: MemoryRevisionId; readonly text: string } | null;
    } | null>(null).pipe(Atom.setIdleTTL(0));
    return Atom.writable(
      (get) => {
        const draft = get(stored);
        if (draft === null || draft.memoryIds.length === 0) return draft?.text ?? null;
        const current = get(state);
        const gaps = draft.memoryIds.map((id) => memoryBodyGap(draft.exposure, current, id));
        if (gaps.every((gap) => gap === "unchanged")) return draft.text;
        const memoryId = draft.memoryIds[0];
        // No current contract field proves independence from earlier summaries, so existing-memory
        // edits close on every same-space forget, reset and disconnect. A version change is decided
        // by its reread: only the revision the edit started from keeps the draft.
        if (draft.start && memoryId && gaps.length === 1 && gaps[0] === "changed") {
          const reply = get(read.reply({ environmentId, input: { ...input, memoryId } }));
          if (reply === null) return draft.text;
          const seen = Option.isSome(reply)
            ? rereadOfRevision(reply.value, draft.start.revisionId)
            : "other";
          if (seen === "same") {
            get.set(stored, { ...draft, exposure: current });
            return draft.text;
          }
          // An edited draft is the person's text: it stays while this device re-scans the same
          // revision. An untouched one is the body, hidden like the read-only view.
          if (seen === "rescanning" && draft.text !== draft.start.text) {
            get.set(stored, { ...draft, exposure: current });
            return draft.text;
          }
        }
        // Purge the retained text, rather than only hiding it from the view.
        get.set(stored, null);
        return null;
      },
      (
        ctx,
        draft: {
          readonly text: string;
          readonly memoryIds: ReadonlyArray<MemoryId>;
          /** The revision the edit starts from; set when seeding, omitted while typing. */
          readonly expectedHeads?: ReadonlyArray<MemoryRevisionId>;
          /** Legacy caller hint; never used as proof of independence. */
          readonly hasRevisionDependencies?: boolean;
        } | null,
      ) => {
        if (draft === null) return ctx.set(stored, null);
        const previous = ctx.get(stored);
        const head = draft.expectedHeads?.length === 1 ? draft.expectedHeads[0] : undefined;
        const typing =
          head === undefined &&
          previous !== null &&
          previous.memoryIds.length === draft.memoryIds.length &&
          previous.memoryIds.every((id, index) => id === draft.memoryIds[index]);
        ctx.set(stored, {
          text: draft.text,
          memoryIds: draft.memoryIds,
          exposure: typing ? previous.exposure : ctx.get(state),
          start: typing
            ? previous.start
            : head === undefined
              ? null
              : { revisionId: head, text: draft.text },
        });
      },
    ).pipe(Atom.withLabel(`memory-draft:${draftId}`), Atom.setIdleTTL(0));
  });

  const importProvider = command(WS_METHODS.memoryImportProvider);

  return {
    /** Release body-free metadata when the owning runtime is disposed. */
    dispose: (registry: AtomRegistry.AtomRegistry) => {
      registry.set(disposedAtom, true);
      ledger.dispose();
    },
    exposureAtom,
    siteNotesList: command(WS_METHODS.siteNotesList),
    siteNotesWrite: command(WS_METHODS.siteNotesWrite),
    siteNotesDelete: command(WS_METHODS.siteNotesDelete),
    siteNotesRestoreSeed: command(WS_METHODS.siteNotesRestoreSeed),
    list: bodyQuery(WS_METHODS.memoryList),
    search: bodyQuery(WS_METHODS.memorySearch),
    read,
    history: bodyQuery(WS_METHODS.memoryHistory),
    resetReportAttempts: command(WS_METHODS.memoryResetReportAttempts),
    hubDiagnostics: command(WS_METHODS.memoryHubDiagnostics),
    hubReconcile: command(WS_METHODS.memoryHubReconcile),
    readSource: bodyQuery(WS_METHODS.memoryReadSource),
    upsert: command(WS_METHODS.memoryUpsert),
    forget: command(WS_METHODS.memoryForget),
    revertResolution: command(WS_METHODS.memoryRevertResolution),
    projectBindingGet: command(WS_METHODS.memoryProjectBindingGet),
    projectBindingUpdate: command(WS_METHODS.memoryProjectBindingUpdate),
    hubSettingsGet: command(WS_METHODS.memoryHubSettingsGet),
    hubSettingsUpdate: command(WS_METHODS.memoryHubSettingsUpdate),
    ownerSourceReadPolicyGet: command(WS_METHODS.memoryOwnerSourceReadPolicyGet),
    ownerSourceReadPolicyUpdate: command(WS_METHODS.memoryOwnerSourceReadPolicyUpdate),
    syncStatus: command(WS_METHODS.memorySyncStatus),
    importProvider,
    createImportWorkflow: (
      registry: AtomRegistry.AtomRegistry,
      options: Omit<Parameters<typeof createMemoryImportWorkflow>[0], "canImport" | "request">,
    ) =>
      createMemoryImportWorkflow({
        ...options,
        canImport: ({ environmentId }) =>
          registry.get(importProvider.permissionAtom(environmentId)),
        request: async (environmentId, input) => {
          const result = await importProvider.run(registry, { environmentId, input });
          if (result._tag === "Failure") throw Cause.squash(result.cause);
          return result.value;
        },
      }),
    draftAtom: (target: MemoryTarget & { readonly draftId: string }) =>
      drafts(JSON.stringify([target.environmentId, target.input, target.draftId])),
  };
}
