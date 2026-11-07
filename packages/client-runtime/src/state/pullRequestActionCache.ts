import {
  PullRequestListResult,
  type EnvironmentId,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestRef,
  type PullRequestSummary,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { type QueryPersistence } from "./queryPersistence.ts";
import { queryPersistenceKey, type QueryAnswerHandler } from "./runtime.ts";
import { isStalePullRequestReply } from "../pullRequestReply.ts";
import { parsePullRequestQuery } from "../pullRequestQuery.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";
export function writableQuery<A, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  idleTtlMs = 5 * 60_000,
) {
  return Atom.writable(
    (get) => {
      const result = get(source);
      if (result._tag === "Success" && !result.waiting) return result;
      const previous = get.self<AsyncResult.AsyncResult<A, E>>();
      const value = Option.flatMap(previous, AsyncResult.value);
      if (Option.isNone(value)) return result;
      return result._tag === "Failure"
        ? AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting })
        : AsyncResult.success<A, E>(value.value, result);
    },
    (context, value: AsyncResult.AsyncResult<A, E>) => context.setSelf(value),
    (refresh) => refresh(source),
  ).pipe(Atom.setIdleTTL(idleTtlMs));
}

interface ActionReplyPatch {
  /** The read this reader is waiting on, if any. */
  readonly pendingRead: (registry: AtomRegistry.AtomRegistry) => object | undefined;
  readonly apply: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    reference: PullRequestRef,
    reply: PullRequestSummary | undefined,
    readsBeforeSend: ReadonlySet<object>,
  ) => Effect.Effect<void>;
}

// Module-wide so readers built by separate factories, such as linked summaries, are patched too.
export const actionReplyPatches = new WeakMap<object, ActionReplyPatch>();

export function samePullRequest(reader: PullRequestRef, acted: PullRequestRef) {
  return (
    reader.projectId === acted.projectId &&
    // A missing host is not a wildcard: one project can reach the same repository on two hosts.
    reader.host?.toLowerCase() === acted.host?.toLowerCase() &&
    reader.repository.toLowerCase() === acted.repository.toLowerCase() &&
    reader.number === acted.number &&
    reader.expectedAccountId === acted.expectedAccountId
  );
}

export function pickDefined<T extends object, K extends keyof T>(
  source: T,
  keys: ReadonlyArray<K>,
): { [P in K]?: Exclude<T[P], undefined> } {
  const picked: { [P in K]?: T[P] } = {};
  for (const key of keys) if (source[key] !== undefined) picked[key] = source[key];
  return picked as { [P in K]?: Exclude<T[P], undefined> };
}

function listAccepts(input: PullRequestListInput, state: string, isDraft: boolean | undefined) {
  const draft = parsePullRequestQuery(input.query ?? "").filters.draft ?? input.filters?.draft;
  return (
    (input.state === "all" || input.state === state) &&
    (draft !== "only" || isDraft !== false) &&
    (draft !== "hide" || isDraft !== true)
  );
}

/**
 * Listing rows with an action's reply applied, the same array when it changes none, and `refresh`
 * when the reply adds the pull request to a listing, which only a read can place.
 */
export function patchPullRequestListEntries<Entry extends PullRequestListEntry>(
  input: PullRequestListInput,
  entries: ReadonlyArray<Entry>,
  reference: PullRequestRef,
  reply: PullRequestSummary,
): ReadonlyArray<Entry> | "refresh" {
  let found = false;
  let changed = false;
  const patched = entries.flatMap((entry): Entry[] => {
    if (!samePullRequest(entry, reference)) return [entry];
    found = true;
    if (isStalePullRequestReply(entry, reply)) return [entry];
    changed = true;
    const next = {
      ...entry,
      ...pickDefined(reply, [
        "title",
        "url",
        "author",
        "headBranch",
        "baseBranch",
        "state",
        "isDraft",
        "mergeability",
        "updatedAt",
      ]),
    };
    return listAccepts(input, next.state, next.isDraft) ? [next] : [];
  });
  if (!found) {
    return input.cursors === undefined && listAccepts(input, reply.state, reply.isDraft)
      ? "refresh"
      : entries;
  }
  return changed
    ? patched.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    : entries;
}

export function patchListWithReply(
  input: PullRequestListInput,
  value: PullRequestListResult,
  reference: PullRequestRef,
  reply: PullRequestSummary,
): PullRequestListResult | "refresh" {
  const entries = patchPullRequestListEntries(input, value.entries, reference, reply);
  if (entries === "refresh") return entries;
  return entries === value.entries ? value : { ...value, entries };
}

/**
 * The query atom for one target, writable so an action's reply can replace what it shows. The
 * patch is saved and announced the way an answer would be, so cold starts and snapshots see it.
 */
export function actionPatchedQuery<Input, A, E>(
  source: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Input;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: {
    readonly label: string;
    readonly persistence?: QueryPersistence<A> | undefined;
    readonly onAnswer?: QueryAnswerHandler<Input, A> | undefined;
    readonly idleTtlMs?: number | undefined;
    readonly concerns: (input: Input, reference: PullRequestRef) => boolean;
    readonly patch: (
      input: Input,
      value: A,
      reference: PullRequestRef,
      reply: PullRequestSummary,
    ) => A | "refresh";
    /** Fields the reply lacks also changed, so the patched value shows while a read fetches them. */
    readonly rereads?: (value: A, reply: PullRequestSummary) => boolean;
    /** Re-read when the host's reply did not carry the pull request. */
    readonly rereadWithoutReply?: boolean;
    /** False for reads the refresh stream does not restart; defaults to true. */
    readonly refreshedByServer?: (input: Input) => boolean;
  },
) {
  const writable = Atom.family((atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    writableQuery(atom, options.idleTtlMs),
  );
  return (target: { readonly environmentId: EnvironmentId; readonly input: Input }) => {
    const query = source(target);
    const atom = writable(query);
    if (actionReplyPatches.has(atom)) return atom;
    const pendingRead = (registry: AtomRegistry.AtomRegistry) => {
      const result = Option.getOrUndefined(
        registry.getNodes().get(query)?.valueOption() ?? Option.none(),
      ) as AsyncResult.AsyncResult<A, E> | undefined;
      return result?.waiting === true ? result : undefined;
    };
    actionReplyPatches.set(atom, {
      pendingRead,
      apply: Effect.fnUntraced(
        function* (registry, environmentId, reference, reply, readsBeforeSend) {
          if (environmentId !== target.environmentId || !options.concerns(target.input, reference))
            return;
          const pending = pendingRead(registry);
          // A read sent before the action may miss its result, and so may one sent before the host
          // committed. The server's post-commit refresh restarts that one, but not a read outside
          // its stream, whose re-read need not even show as waiting, so a mounted one the reply
          // changes restarts here.
          const unrefreshed = options.refreshedByServer?.(target.input) === false;
          const freshRead = pending !== undefined && !unrefreshed && !readsBeforeSend.has(pending);
          const reread = () => (freshRead ? undefined : registry.refresh(atom));
          if (reply === undefined) {
            return options.rereadWithoutReply === true ? reread() : undefined;
          }
          const shown = Option.flatMap(
            registry.getNodes().get(atom)?.valueOption() ?? Option.none(),
            (current: AsyncResult.AsyncResult<A, E>) => AsyncResult.value(current),
          );
          if (Option.isNone(shown)) return reread();
          const patched = options.patch(target.input, shown.value, reference, reply);
          if (patched === "refresh") return reread();
          const lacking = options.rereads?.(shown.value, reply) === true;
          const next = reuseUnchanged(shown.value, patched);
          if (next === shown.value)
            return lacking || (unrefreshed && pending !== undefined) ? reread() : undefined;
          yield* options.onAnswer?.(target, next, registry) ?? Effect.void;
          const mounted = (registry.getNodes().get(atom)?.listeners.size ?? 0) > 0;
          if (!freshRead && (pending !== undefined || lacking || (unrefreshed && mounted)))
            registry.refresh(atom);
          registry.update(
            atom,
            AsyncResult.map(() => next),
          );
          if (options.persistence !== undefined) {
            yield* options.persistence.save(
              environmentId,
              queryPersistenceKey(options.label, target.input),
              next,
            );
          }
        },
      ),
    });
    return atom;
  };
}
