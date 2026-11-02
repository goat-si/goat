import * as M from "@goat/contracts";
import * as Renderer from "@goat/provider-core/server/memoryContext";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import { makeShellThreadRows } from "../orchestration-v2/ProjectionShellThreadRows.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Settings from "../serverSettings.ts";
import * as Related from "./memorySnapshotRelated.ts";
import { scopeKey } from "./store/StoreCodecs.ts";

/** L5/L2 supply already-intersected committed authority, never caller wire data. */
export type MemorySnapshotPolicy = {
  readonly grant: M.MemoryTaskGrantCeiling;
  readonly policyEpoch: number;
  readonly finalAuthority?: Effect.Effect<boolean>;
};
type CurrentPolicy = Effect.Effect<MemorySnapshotPolicy>;
export class MemorySnapshotError extends Schema.TaggedError<MemorySnapshotError>()(
  "MemorySnapshotError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Memory snapshot unavailable.";
  }
}
export class MemorySnapshot extends Context.Service<
  MemorySnapshot,
  {
    readonly forThread: (
      threadId: M.ThreadId,
      policy: MemorySnapshotPolicy,
      currentPolicy: CurrentPolicy,
    ) => Effect.Effect<M.MemoryContextSnapshot | undefined, MemorySnapshotError>;
    readonly revalidate: (
      snapshot: M.MemoryContextSnapshot,
      execution: { threadId: M.ThreadId; runId: M.RunId },
      currentPolicy: CurrentPolicy,
    ) => Effect.Effect<M.MemoryContextSnapshot | undefined, MemorySnapshotError>;
    readonly invalidate: (threadId: M.ThreadId) => Effect.Effect<void>;
  }
>()("goat/memory/MemorySnapshot") {}

const encodeBinding = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(M.MemoryProjectBinding)),
);
const encodeScope = Schema.encodeSync(Schema.fromJsonString(M.MemoryScope));
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(M.MemoryContextSnapshot));

const make = Effect.gen(function* () {
  const service = yield* Service.MemoryService;
  const store = yield* Store.MemoryStore;
  const sync = yield* Sync.MemorySyncService;
  const projection = yield* Projection.ProjectionStoreV2;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const sql = yield* SqlClient.SqlClient;
  const { isSilentShellRun } = makeShellThreadRows(sql);
  const settings = yield* Settings.MemoryHubCommittedSettings;
  const capture = Effect.fnUntraced(function* (threadId: M.ThreadId) {
    // Readiness may acquire the settings lane; never hold the SQL lane while reading it.
    const hubEpoch = (yield* settings.read).version;
    const readiness = yield* sync.readLocalReadiness();
    if ((yield* settings.read).version !== hubEpoch) return undefined;
    if (readiness.bootstrap !== "ready" || !readiness.memorySpaceId) return undefined;
    const space = readiness.memorySpaceId;
    return yield* store.transact(
      Effect.gen(function* () {
        const thread = yield* projection.getThreadShell(threadId);
        if (!thread?.activeRunId) return undefined;
        if (
          !thread.activityRunStatus ||
          !["preparing", "starting", "running", "waiting"].includes(thread.activityRunStatus)
        )
          return undefined;
        const project = { environmentId, projectId: thread.projectId };
        // resolveProjectKey may discover repository identity. Resolve outside these short reads;
        // here the committed binding is compared verbatim, including its version.
        const binding = yield* store.getProjectBinding(space, project);
        const rows = yield* sql<{
          watermark: number;
        }>`SELECT coalesce((SELECT projection_watermark FROM memory_compaction_state WHERE space=${space}),0) AS watermark`;
        return {
          space,
          hubEpoch,
          threadId,
          runId: thread.activeRunId,
          project,
          binding,
          watermark: rows[0]!.watermark,
        };
      }),
    );
  });
  // The writer transaction pins canonical identity and the selected payload's already
  // flattened lineage before any adapter can receive the snapshot. A failed write sends none.
  const admit = Effect.fnUntraced(function* (
    snapshot: M.MemoryContextSnapshot,
    view: NonNullable<Effect.Success<ReturnType<typeof capture>>>,
    policy: MemorySnapshotPolicy,
    relatedBindings: ReadonlyMap<string, string>,
    currentSelection: Effect.Effect<boolean>,
  ) {
    const own = { environmentId, threadId: view.threadId };
    const hasRelated = snapshot.items.some((item) => Related.isRelated(item.scope, own));
    if (!policy.finalAuthority) return false;
    const fenced = () => new Store.MemoryStoreConflict({ code: "fenced" });
    return yield* store
      .transact(
        Effect.gen(function* () {
          const destination = yield* sql<{
            project_id: string;
            deleted_at: string | null;
            archived_at: string | null;
            run_id: string | null;
          }>`
          SELECT t.project_id,t.deleted_at,t.archived_at,
            (SELECT r.run_id FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.thread_id
              AND r.status IN ('preparing','starting','running')
              AND NOT ${isSilentShellRun("r")}
              ORDER BY r.ordinal DESC,r.run_id DESC LIMIT 1) AS run_id
          FROM orchestration_v2_projection_threads t WHERE t.thread_id=${view.threadId}`;
          const row = destination[0];
          if (
            !row ||
            row.deleted_at !== null ||
            row.archived_at !== null ||
            row.project_id !== view.project.projectId ||
            row.run_id !== view.runId ||
            encodeBinding((yield* store.getProjectBinding(view.space, view.project)) ?? null) !==
              encodeBinding(view.binding ?? null)
          )
            return false;
          const keys = hasRelated
            ? yield* Related.relatedKeysFor(store, sql, view.space, own, view.project)
            : new Map<string, string>();
          const revisions: M.MemoryRevisionId[] = [];
          for (const item of snapshot.items) {
            const current = yield* store.loadAggregate(snapshot.memorySpaceId, item.memoryId);
            const pair = current.revisions.find((p) => p.revision.revisionId === item.revisionId);
            if (
              current.tombstone ||
              current.pendingForget ||
              current.heads.length !== 1 ||
              current.heads[0] !== item.revisionId ||
              !pair?.payload ||
              !current.item ||
              current.item.status !== "active" ||
              current.item.memorySpaceId !== view.space ||
              current.item.localAvailability.exposure !== "visible" ||
              encodeScope(current.item.scope) !== encodeScope(item.scope) ||
              (Related.isRelated(item.scope, own) &&
                (!keys.has(scopeKey(item.scope)) ||
                  keys.get(scopeKey(item.scope)) !== relatedBindings.get(scopeKey(item.scope))))
            )
              return false;
            yield* Service.validateSummaryDependencies(snapshot.memorySpaceId, {
              ...pair.payload,
              derivedFromMemoryRevisions: [
                item.revisionId,
                ...pair.payload.derivedFromMemoryRevisions,
              ],
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            revisions.push(item.revisionId, ...pair.payload.derivedFromMemoryRevisions);
          }
          if (hasRelated) {
            const lineage = yield* store.readThreadLineage(own, view.space);
            if (
              lineage.state !== "tracked" ||
              new Set([...lineage.revisions, ...revisions]).size > 80
            )
              return false;
          }
          if (!revisions.length) return true;
          return yield* store.appendThreadLineage(own, snapshot.memorySpaceId, revisions);
        }),
        {
          finalGuard: Effect.gen(function* () {
            if (
              !(yield* currentSelection) ||
              (policy.finalAuthority && !(yield* policy.finalAuthority)) ||
              !(yield* currentSelection) ||
              (yield* settings.read).version !== view.hubEpoch
            )
              return yield* fenced();
          }),
        },
      )
      .pipe(
        Effect.catchTags({
          MemoryStoreConflict: (error) =>
            error.code === "fenced" ? Effect.succeed(false) : Effect.fail(error),
        }),
      );
  });
  type View = NonNullable<Effect.Success<ReturnType<typeof capture>>>;
  const sameView = (a: View, b: View | undefined) =>
    !!b &&
    a.space === b.space &&
    a.hubEpoch === b.hubEpoch &&
    a.threadId === b.threadId &&
    a.runId === b.runId &&
    a.project.projectId === b.project.projectId &&
    encodeBinding(a.binding ?? null) === encodeBinding(b.binding ?? null) &&
    a.watermark === b.watermark;
  const packWithLineage = Effect.fnUntraced(function* (
    view: View,
    own: M.ScopedThreadRef,
    base: readonly M.MemoryContextCandidate[],
    related: readonly M.MemoryContextCandidate[],
    insertAt: number,
    hasMore: boolean,
  ) {
    let optional = related;
    while (true) {
      const snapshot = Renderer.packMemoryContext({
        memorySpaceId: view.space,
        projectionWatermark: view.watermark,
        items: [...base.slice(0, insertAt), ...optional, ...base.slice(insertAt)],
        hasMore,
      });
      if (!snapshot || !snapshot.items.some((item) => Related.isRelated(item.scope, own)))
        return snapshot;
      const fits = yield* store.transact(
        Effect.gen(function* () {
          const lineage = yield* store.readThreadLineage(own, view.space);
          const revisions = new Set(lineage.revisions);
          if (lineage.state !== "tracked") return false;
          for (const item of snapshot.items) {
            const aggregate = yield* store.loadAggregate(view.space, item.memoryId);
            const pair = aggregate.revisions.find((p) => p.revision.revisionId === item.revisionId);
            if (!pair?.payload) return false;
            revisions.add(item.revisionId);
            for (const revision of pair.payload.derivedFromMemoryRevisions) revisions.add(revision);
          }
          return revisions.size <= 80;
        }),
      );
      if (fits) return snapshot;
      optional = optional.slice(0, -1);
    }
  });
  // Association metadata owns no bodies; adapters own the returned snapshot lifetime.
  const associations = new WeakMap<M.MemoryContextSnapshot, symbol>();
  const entries = new Map<
    symbol,
    {
      token: symbol;
      view: View;
      epoch: number;
      finalAuthority?: Effect.Effect<boolean>;
      relatedBindings: ReadonlyMap<string, string>;
      expires: number;
      bytes: number;
      hasMore: boolean;
      selected: ReadonlyArray<{
        memoryId: M.MemoryId;
        revisionId: M.MemoryRevisionId;
        scopeKey: string;
      }>;
    }
  >();
  // In-flight selections also consume bounded metadata; eviction cancels their admission.
  const tokens = new Map<M.ThreadId, { token: symbol; expires: number }>();
  const tokenBytes = 256;
  let cacheBytes = 0;
  const removeToken = (threadId: M.ThreadId) => {
    if (tokens.delete(threadId)) cacheBytes -= tokenBytes;
  };
  const removeEntry = (key: symbol) => {
    const entry = entries.get(key);
    if (entry) cacheBytes -= entry.bytes;
    entries.delete(key);
  };
  const remove = (snapshot: M.MemoryContextSnapshot) => {
    const key = associations.get(snapshot);
    if (key) removeEntry(key);
    associations.delete(snapshot);
  };
  const sweep = (now: number) => {
    for (const [key, entry] of entries) if (entry.expires <= now) removeEntry(key);
    for (const [threadId, token] of tokens) if (token.expires <= now) removeToken(threadId);
  };
  const invalidate = (threadId: M.ThreadId) =>
    Effect.sync(() => {
      removeToken(threadId);
      for (const [key, entry] of entries) if (entry.view.threadId === threadId) removeEntry(key);
    });
  const reserve = (bytes: number) => {
    while (cacheBytes + bytes > M.MEMORY_DERIVED_CACHE_MAX_BYTES) {
      if (entries.size) removeEntry(entries.keys().next().value!);
      else if (tokens.size) removeToken(tokens.keys().next().value!);
      else return false;
    }
    return true;
  };
  const permits = (policy: MemorySnapshotPolicy, expected: MemorySnapshotPolicy) =>
    policy.grant !== "none" && policy.policyEpoch === expected.policyEpoch;
  const forThread = Effect.fn("MemorySnapshot.forThread")(
    function* (threadId: M.ThreadId, policy: MemorySnapshotPolicy, currentPolicy: CurrentPolicy) {
      yield* invalidate(threadId);
      const started = yield* Clock.currentTimeMillis;
      sweep(started);
      const token = Symbol();
      const expires = started + M.MEMORY_DERIVED_CACHE_TTL_MS;
      if (!reserve(tokenBytes)) return undefined;
      tokens.set(threadId, { token, expires });
      cacheBytes += tokenBytes;
      if (!permits(yield* currentPolicy, policy) || policy.grant === "none") return undefined;
      const initial = yield* capture(threadId);
      if (!initial) return undefined;
      // Preserve existing explicit/repository mapping semantics, including discovery outside SQL.
      const projectKey = yield* service.resolveProjectKey(initial.space, initial.project);
      const view = yield* capture(threadId);
      if (
        !view ||
        view.space !== initial.space ||
        view.hubEpoch !== initial.hubEpoch ||
        view.runId !== initial.runId ||
        view.project.projectId !== initial.project.projectId ||
        view.watermark !== initial.watermark
      )
        return undefined;
      const scopes: M.MemoryScope[] = [
        { kind: "thread", thread: { environmentId, threadId } },
        ...(projectKey ? [{ kind: "project" as const, projectKey }] : []),
        { kind: "user" },
      ];
      let pages = 0;
      let hasMore = false;
      const candidates: M.MemoryContextCandidate[] = [];
      for (const [index, scope] of scopes.entries()) {
        // Guarantee each remaining scope a share; unused pages flow to the next scope.
        const pageBudget = Math.floor((10 - pages) / (scopes.length - index));
        let scopePages = 0;
        let cursor: string | undefined;
        do {
          if (!permits(yield* currentPolicy, policy) || !sameView(view, yield* capture(threadId)))
            return undefined;
          // Each page reserves 100 slots and 64 KiB, regardless of filtering/oversize output.
          pages++;
          scopePages++;
          const page = yield* service.readContextCandidates(
            {
              memorySpaceId: view.space,
              scope,
              limit: 100,
              includeQuarantined: true,
              ...(cursor ? { cursor } : {}),
            },
            Effect.void,
          );
          if (page.projectionWatermark !== view.watermark) return undefined;
          candidates.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor && scopePages < pageBudget);
        hasMore ||= !!cursor;
      }
      if (!permits(yield* currentPolicy, policy) || !sameView(view, yield* capture(threadId)))
        return undefined;
      const own = { environmentId, threadId };
      const message = yield* projection.getRunMessage(threadId, view.runId);
      const ownCount = candidates.findIndex((item) => item.scope.kind !== "thread");
      const related =
        policy.finalAuthority && message?.role === "user" && message.text.trim()
          ? yield* Related.selectRelated(
              store,
              sql,
              view.space,
              own,
              view.project,
              message.text,
              new Set(candidates.map((item) => item.memoryId)),
            )
          : { items: [], bindings: new Map<string, string>() };
      const insertAt = ownCount < 0 ? candidates.length : ownCount;
      const snapshot = yield* packWithLineage(
        view,
        own,
        candidates,
        related.items,
        insertAt,
        hasMore,
      );
      if (!snapshot) return undefined;
      const bytes = yield* Effect.try({
        try: () => 2 * new TextEncoder().encode(encodeSnapshot(snapshot)).length,
        catch: (cause) => new MemorySnapshotError({ cause }),
      });
      const now = yield* Clock.currentTimeMillis;
      sweep(now);
      if (
        tokens.get(threadId)?.token !== token ||
        expires <= now ||
        !reserve(bytes) ||
        tokens.get(threadId)?.token !== token
      )
        return undefined;
      const key = Symbol();
      associations.set(snapshot, key);
      entries.set(key, {
        token,
        view,
        epoch: policy.policyEpoch,
        ...(policy.finalAuthority ? { finalAuthority: policy.finalAuthority } : {}),
        relatedBindings: new Map(
          snapshot.items.flatMap((item) => {
            const key = scopeKey(item.scope);
            const binding = related.bindings.get(key);
            return binding === undefined ? [] : [[key, binding] as const];
          }),
        ),
        expires,
        bytes,
        hasMore:
          snapshot.renderedText ===
          Renderer.renderMemoryContext(snapshot.items, true, snapshot.protocolVersion, view.space),
        selected: snapshot.items.map((item) => ({
          memoryId: item.memoryId,
          revisionId: item.revisionId,
          scopeKey: encodeScope(item.scope),
        })),
      });
      cacheBytes += bytes;
      if (
        !(yield* admit(
          snapshot,
          view,
          policy,
          related.bindings,
          Effect.gen(function* () {
            return (
              entries.has(key) &&
              tokens.get(threadId)?.token === token &&
              expires > (yield* Clock.currentTimeMillis)
            );
          }),
        ).pipe(Effect.tapError(() => Effect.sync(() => remove(snapshot)))))
      ) {
        remove(snapshot);
        return undefined;
      }
      return snapshot;
    },
    Effect.mapError((cause) => new MemorySnapshotError({ cause })),
  );
  const revalidate = Effect.fn("MemorySnapshot.revalidate")(
    function* (
      snapshot: M.MemoryContextSnapshot,
      execution: { threadId: M.ThreadId; runId: M.RunId },
      currentPolicy: CurrentPolicy,
    ) {
      sweep(yield* Clock.currentTimeMillis);
      yield* Effect.try({
        try: () => Renderer.validateMemoryContext(snapshot),
        catch: (cause) => new MemorySnapshotError({ cause }),
      });
      const key = associations.get(snapshot);
      const entry = key ? entries.get(key) : undefined;
      const clear = () => {
        remove(snapshot);
        return undefined;
      };
      if (
        !entry ||
        snapshot.memorySpaceId !== entry.view.space ||
        tokens.get(execution.threadId)?.token !== entry.token ||
        entry.view.threadId !== execution.threadId ||
        entry.view.runId !== execution.runId
      )
        return clear();
      if (
        snapshot.items.length !== entry.selected.length ||
        snapshot.items.some((item, index) => {
          const original = entry.selected[index]!;
          return (
            item.memoryId !== original.memoryId ||
            item.revisionId !== original.revisionId ||
            encodeScope(item.scope) !== original.scopeKey
          );
        })
      )
        return clear();
      const policy = yield* currentPolicy;
      if (!permits(policy, { grant: "read", policyEpoch: entry.epoch })) return clear();
      const view = yield* capture(execution.threadId);
      // Restore allows a newer watermark, but never a different execution or binding.
      if (!view || !sameView({ ...entry.view, watermark: view.watermark }, view)) return clear();
      const current = yield* service.readContextRevisions(
        entry.view.space,
        entry.selected.map((i) => i.memoryId),
        Effect.void,
      );
      if (
        current.memorySpaceId !== entry.view.space ||
        current.projectionWatermark !== view.watermark
      )
        return clear();
      const own = { environmentId, threadId: execution.threadId };
      const relatedKeys = yield* store.transact(
        Related.relatedKeysFor(store, sql, view.space, own, view.project),
      );
      const survivors = entry.selected.flatMap((original) =>
        current.items.filter(
          (item) =>
            item.memoryId === original.memoryId &&
            item.revisionId === original.revisionId &&
            encodeScope(item.scope) === original.scopeKey &&
            (!Related.isRelated(item.scope, own) ||
              (relatedKeys.has(scopeKey(item.scope)) &&
                relatedKeys.get(scopeKey(item.scope)) ===
                  entry.relatedBindings.get(scopeKey(item.scope)))),
        ),
      );
      if (
        !permits(yield* currentPolicy, policy) ||
        !sameView(view, yield* capture(execution.threadId))
      )
        return clear();
      const base = survivors.filter((item) => !Related.isRelated(item.scope, own));
      const related = survivors.filter((item) => Related.isRelated(item.scope, own));
      const firstNonThread = base.findIndex((item) => item.scope.kind !== "thread");
      const restored = yield* packWithLineage(
        view,
        own,
        base,
        related,
        firstNonThread < 0 ? base.length : firstNonThread,
        entry.hasMore,
      );
      if (!restored) return clear();
      const bytes = yield* Effect.try({
        try: () => 2 * new TextEncoder().encode(encodeSnapshot(restored)).length,
        catch: (cause) => new MemorySnapshotError({ cause }),
      });
      const now = yield* Clock.currentTimeMillis;
      sweep(now);
      if (
        entry.expires <= now ||
        entries.get(key!) !== entry ||
        tokens.get(execution.threadId)?.token !== entry.token ||
        !reserve(bytes) ||
        entries.get(key!) !== entry ||
        tokens.get(execution.threadId)?.token !== entry.token
      )
        return clear();
      const restoredKey = Symbol();
      associations.set(restored, restoredKey);
      entries.set(restoredKey, {
        ...entry,
        view,
        bytes,
        selected: restored.items.map((item) => ({
          memoryId: item.memoryId,
          revisionId: item.revisionId,
          scopeKey: encodeScope(item.scope),
        })),
      });
      cacheBytes += bytes;
      if (
        !(yield* admit(
          restored,
          view,
          {
            ...policy,
            ...(entry.finalAuthority ? { finalAuthority: entry.finalAuthority } : {}),
          },
          entry.relatedBindings,
          Effect.gen(function* () {
            return (
              key !== undefined &&
              entries.get(key) === entry &&
              entries.has(restoredKey) &&
              tokens.get(execution.threadId)?.token === entry.token &&
              entry.expires > (yield* Clock.currentTimeMillis)
            );
          }),
        ).pipe(Effect.tapError(() => Effect.sync(() => remove(restored)))))
      ) {
        remove(restored);
        return clear();
      }
      return restored;
    },
    Effect.mapError((cause) => new MemorySnapshotError({ cause })),
  );
  return MemorySnapshot.of({
    forThread,
    revalidate: (snapshot, execution, currentPolicy) =>
      revalidate(snapshot, execution, currentPolicy).pipe(
        Effect.tapError(() => Effect.sync(() => remove(snapshot))),
      ),
    invalidate,
  });
});
export const layer = Layer.effect(MemorySnapshot, make);
