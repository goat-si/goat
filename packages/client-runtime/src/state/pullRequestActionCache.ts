import {
  PullRequestListResult,
  type EnvironmentId,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestRef,
  type PullRequestSummary,
  type PullRequestActionInput,
  type PullRequestUpdateInput,
  type PullRequestLabel,
  type PullRequestLabelCandidateList,
  type PullRequestState,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { type QueryPersistence } from "./queryPersistence.ts";
import { queryPersistenceKey, type QueryAnswerHandler, type AtomCommand } from "./runtime.ts";
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

/** What a write in flight will change, shown by every reader until the host answers. */
export interface PullRequestPendingEdit {
  readonly reference: PullRequestRef;
  readonly state?: PullRequestState;
  readonly isDraft?: boolean;
  readonly autoMergeEnabled?: boolean;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: {
    readonly applied: boolean;
    readonly labels: ReadonlyArray<PullRequestLabel>;
  };
}

type EditedField = "state" | "isDraft" | "autoMergeEnabled" | "title" | "body";

interface EditableReader {
  readonly environmentId: EnvironmentId;
  readonly concerns: (reference: PullRequestRef) => boolean;
  readonly edit: (
    value: never,
    edits: ReadonlyArray<PullRequestPendingEdit>,
    pending?: ReadonlyArray<PullRequestPendingEdit>,
  ) => unknown;
}

// Module-wide like the reply patches, so separately built readers see the same writes.
export const pullRequestPendingEditsAtom = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make<ReadonlyArray<PullRequestPendingEdit>>([]).pipe(Atom.keepAlive),
);
const editableReaders = new WeakMap<object, EditableReader>();
const editedReaders = new WeakMap<object, object>();
export const uneditedReaders = new WeakMap<object, object>();

const pendingEditsByPullRequest = Atom.family((key: string) => {
  const [environmentId, reference] = JSON.parse(key) as [EnvironmentId, PullRequestRef];
  return Atom.make((get) =>
    get(pullRequestPendingEditsAtom(environmentId)).filter((edit) =>
      samePullRequest(reference, edit.reference),
    ),
  ).pipe(
    Atom.withEquality(
      (previous: ReadonlyArray<PullRequestPendingEdit>, next) =>
        previous.length === next.length && previous.every((edit, index) => edit === next[index]),
    ),
  );
});
const noPendingEdits = Atom.make<ReadonlyArray<PullRequestPendingEdit>>([]);

export function pullRequestPendingEditsFor(
  environmentId: EnvironmentId | null,
  reference: PullRequestRef | null,
): Atom.Atom<ReadonlyArray<PullRequestPendingEdit>> {
  return environmentId === null || reference === null
    ? noPendingEdits
    : pendingEditsByPullRequest(JSON.stringify([environmentId, pullRequestReference(reference)]));
}

export function pullRequestHostAnswer<A>(reader: Atom.Atom<A>): Atom.Atom<A> {
  return (uneditedReaders.get(reader) ?? reader) as Atom.Atom<A>;
}

export function loadedValue<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<unknown>) {
  return Option.flatMap(registry.getNodes().get(atom)?.valueOption() ?? Option.none(), (result) =>
    AsyncResult.value(result as AsyncResult.AsyncResult<A, unknown>),
  );
}

export function withEdit<T extends object>(
  value: T,
  edit: PullRequestPendingEdit,
  fields: ReadonlyArray<EditedField>,
): T {
  const held = value as Record<string, unknown>;
  const changed = fields.filter(
    (field) => edit[field] !== undefined && held[field] !== edit[field],
  );
  let next =
    changed.length === 0
      ? held
      : { ...held, ...Object.fromEntries(changed.map((field) => [field, edit[field]])) };
  if (edit.autoMergeEnabled === false && next.autoMergeMethod !== undefined) {
    const { autoMergeMethod: _disarmed, ...withoutAutoMerge } = next;
    next = withoutAutoMerge;
  }
  return next as T;
}

export function withLabelEdit<T extends { readonly labels: ReadonlyArray<PullRequestLabel> }>(
  value: T,
  edit: PullRequestPendingEdit,
): T {
  if (edit.labels === undefined) return value;
  const { applied, labels: changed } = edit.labels;
  const names = new Set(changed.map((label) => label.name));
  const labels = applied
    ? [
        ...value.labels,
        ...changed.filter((label) => !value.labels.some((held) => held.name === label.name)),
      ]
    : value.labels.filter((label) => !names.has(label.name));
  return labels.length === value.labels.length ? value : { ...value, labels };
}

export function withLabelCandidateEdit(
  value: PullRequestLabelCandidateList,
  edit: PullRequestPendingEdit,
): PullRequestLabelCandidateList {
  if (edit.labels === undefined) return value;
  const { applied, labels } = edit.labels;
  let changed = false;
  const candidates = value.candidates.map((candidate) => {
    if (candidate.isApplied === applied || !labels.some((label) => label.name === candidate.name))
      return candidate;
    changed = true;
    return { ...candidate, isApplied: applied };
  });
  return changed ? { ...value, candidates } : value;
}

/**
 * The reader with every write in flight for its pull request applied. Writes go to the reader
 * underneath, so a refused edit never stays behind in what the host said.
 */
export function editedQuery<A, E>(
  inner: Atom.Writable<AsyncResult.AsyncResult<A, E>>,
  reader: Omit<EditableReader, "edit"> & {
    readonly edit: (
      value: A,
      edits: ReadonlyArray<PullRequestPendingEdit>,
      pending?: ReadonlyArray<PullRequestPendingEdit>,
    ) => A;
  },
  idleTtlMs = 5 * 60_000,
): Atom.Writable<AsyncResult.AsyncResult<A, E>> {
  const existing = editedReaders.get(inner);
  if (existing !== undefined) return existing as Atom.Writable<AsyncResult.AsyncResult<A, E>>;
  const shown = Atom.writable(
    (get) => {
      const result = get(inner);
      const edits = get(pullRequestPendingEditsAtom(reader.environmentId)).filter((edit) =>
        reader.concerns(edit.reference),
      );
      const value = AsyncResult.value(result);
      if (Option.isNone(value)) return result;
      const next = reader.edit(value.value, edits);
      return next === value.value ? result : AsyncResult.map(result, () => next);
    },
    (context, value: AsyncResult.AsyncResult<A, E>) => context.set(inner, value),
    (refresh) => refresh(inner),
  ).pipe(Atom.setIdleTTL(idleTtlMs));
  editableReaders.set(inner, reader as EditableReader);
  editedReaders.set(inner, shown);
  uneditedReaders.set(shown, inner);
  return shown;
}

/** Shows the command's edit from the click until it settles, queued behind others or not. */
export function showWhileInFlight<
  Target extends { readonly environmentId: EnvironmentId },
  A,
  E,
  C,
>(
  command: C & AtomCommand<Target, A, E>,
  editOf: (registry: AtomRegistry.AtomRegistry, target: Target) => PullRequestPendingEdit | null,
): C {
  return {
    ...command,
    run: async (registry, target) => {
      const edit = editOf(registry, target);
      if (edit === null) return command.run(registry, target);
      const edits = pullRequestPendingEditsAtom(target.environmentId);
      registry.update(edits, (current) => [...current, edit]);
      try {
        return await command.run(registry, target);
      } finally {
        registry.update(edits, (current) => current.filter((entry) => entry !== edit));
      }
    },
  } satisfies AtomCommand<Target, A, E>;
}

/** Keeps an accepted edit in loaded readers once it stops being in flight. */
export function settleEdit(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  edit: PullRequestPendingEdit | null,
  readsAfterWrite = false,
) {
  if (edit === null) return;
  const pending = registry.get(pullRequestPendingEditsAtom(environmentId));
  for (const atom of registry.getNodes().keys()) {
    const reader = typeof atom === "string" ? undefined : editableReaders.get(atom);
    if (reader?.environmentId !== environmentId || !reader.concerns(edit.reference)) continue;
    const shown = loadedValue<never>(registry, atom as Atom.Atom<unknown>);
    const writable = atom as Atom.Writable<AsyncResult.AsyncResult<never, unknown>>;
    const unchanged =
      Option.isSome(shown) && reader.edit(shown.value, [edit], pending) === shown.value;
    if (unchanged) continue;
    // A read still waiting may predate the write, unless the caller started it after the commit.
    if (!readsAfterWrite && registry.get(writable).waiting) registry.refresh(writable);
    if (Option.isNone(shown)) continue;
    registry.update(
      writable,
      AsyncResult.map((value) => reader.edit(value, [edit], pending) as never),
    );
  }
}

export function pullRequestReference(input: PullRequestRef): PullRequestRef {
  const { projectId, host, repository, number, expectedAccountId } = input;
  return {
    projectId,
    ...(host === undefined ? {} : { host }),
    repository,
    number,
    ...(expectedAccountId === undefined ? {} : { expectedAccountId }),
  };
}

/** What an action changes, left out where only the host knows, as when a queue takes a merge. */
export function actionEdit(input: PullRequestActionInput): PullRequestPendingEdit | null {
  if (input.stackNumber !== undefined) return null;
  const reference = pullRequestReference(input);
  switch (input.action) {
    case "close":
      return { reference, state: "closed" };
    case "reopen":
      return { reference, state: "open" };
    case "ready":
      return { reference, isDraft: false };
    case "draft":
      return { reference, isDraft: true };
    case "enable-auto-merge":
      return { reference, autoMergeEnabled: true };
    case "disable-auto-merge":
      return { reference, autoMergeEnabled: false };
    default:
      return null;
  }
}

export function updateEdit(input: PullRequestUpdateInput): PullRequestPendingEdit | null {
  if (input.title === undefined && input.body === undefined) return null;
  return {
    reference: pullRequestReference(input),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}

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

export function applyPullRequestSummaryEdits(
  reference: PullRequestRef | null,
  summary: PullRequestSummary | null,
  edits: ReadonlyArray<PullRequestPendingEdit>,
): PullRequestSummary | null {
  if (reference === null || summary === null) return summary;
  return edits.reduce(
    (current, edit) =>
      samePullRequest(reference, edit.reference)
        ? withEdit(current, edit, ["state", "isDraft", "autoMergeEnabled", "title"])
        : current,
    summary,
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

function listKeeps(
  input: PullRequestListInput,
  entry: PullRequestListEntry,
  pending: ReadonlyArray<PullRequestPendingEdit>,
) {
  if (listAccepts(input, entry.state, entry.isDraft)) return true;
  const edited = pending.reduce(
    (current, edit) =>
      samePullRequest(entry, edit.reference)
        ? withEdit(current, edit, ["state", "isDraft"])
        : current,
    entry,
  );
  return edited !== entry && listAccepts(input, edited.state, edited.isDraft);
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
  pending: ReadonlyArray<PullRequestPendingEdit> = [],
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
    return listKeeps(input, next, pending) ? [next] : [];
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

export function editPullRequestListEntries<Entry extends PullRequestListEntry>(
  input: PullRequestListInput,
  entries: ReadonlyArray<Entry>,
  edits: ReadonlyArray<PullRequestPendingEdit>,
  pending = edits,
): ReadonlyArray<Entry> {
  let changed = false;
  const edited = entries.flatMap((entry): Entry[] => {
    const next = edits.reduce(
      (current, edit) =>
        samePullRequest(entry, edit.reference)
          ? withLabelEdit(withEdit(current, edit, ["state", "isDraft", "title"]), edit)
          : current,
      entry,
    );
    if (next === entry && listAccepts(input, next.state, next.isDraft)) return [entry];
    changed = true;
    return listKeeps(input, next, pending) ? [next] : [];
  });
  return changed ? edited : entries;
}

export function editHeldPullRequestListEntries<Entry extends PullRequestListEntry>(
  input: PullRequestListInput,
  entries: ReadonlyArray<Entry>,
  editsOf: (entry: Entry) => ReadonlyArray<PullRequestPendingEdit>,
  pending?: ReadonlyArray<PullRequestPendingEdit>,
): ReadonlyArray<Entry> {
  let changed = false;
  const shown = entries.flatMap((entry) => {
    const edits = editsOf(entry);
    const next = editPullRequestListEntries(input, [entry], edits, pending);
    if (next[0] !== entry) changed = true;
    return next;
  });
  return changed ? shown : entries;
}

export function heldPullRequestListEntriesAtom<Entry extends PullRequestListEntry>(
  environmentId: EnvironmentId,
  input: PullRequestListInput,
  entries: ReadonlyArray<Entry>,
) {
  return actionPatchedQuery(() => Atom.make(AsyncResult.success(entries)), {
    label: "pull-requests:held-list-entries",
    concerns: (_input: PullRequestListInput, reference) =>
      entries.some((entry) => samePullRequest(entry, reference)),
    edit: editPullRequestListEntries<Entry>,
    patch: patchPullRequestListEntries<Entry>,
  })({ environmentId, input });
}

export function patchListWithReply(
  input: PullRequestListInput,
  value: PullRequestListResult,
  reference: PullRequestRef,
  reply: PullRequestSummary,
  pending: ReadonlyArray<PullRequestPendingEdit>,
): PullRequestListResult | "refresh" {
  const entries = patchPullRequestListEntries(input, value.entries, reference, reply, pending);
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
      pending: ReadonlyArray<PullRequestPendingEdit>,
    ) => A | "refresh";
    /** Fields the reply lacks also changed, so the patched value shows while a read fetches them. */
    readonly rereads?: (value: A, reply: PullRequestSummary) => boolean;
    /** Re-read when the host's reply did not carry the pull request. */
    readonly rereadWithoutReply?: boolean;
    /** False for reads the refresh stream does not restart; defaults to true. */
    readonly refreshedByServer?: (input: Input) => boolean;
    /** Shows a write in flight; absent where the reader holds nothing such a write changes. */
    readonly edit?: (
      input: Input,
      value: A,
      edits: ReadonlyArray<PullRequestPendingEdit>,
      pending?: ReadonlyArray<PullRequestPendingEdit>,
    ) => A;
  },
) {
  const writable = Atom.family((atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    writableQuery(atom, options.idleTtlMs),
  );
  return (target: { readonly environmentId: EnvironmentId; readonly input: Input }) => {
    const query = source(target);
    const atom = writable(query);
    const edit = options.edit;
    const reader =
      edit === undefined
        ? atom
        : editedQuery(
            atom,
            {
              environmentId: target.environmentId,
              concerns: (reference) => options.concerns(target.input, reference),
              edit: (value, edits, pending) => edit(target.input, value, edits, pending),
            },
            options.idleTtlMs,
          );
    if (actionReplyPatches.has(atom)) return reader;
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
          const patched = options.patch(
            target.input,
            shown.value,
            reference,
            reply,
            registry.get(pullRequestPendingEditsAtom(environmentId)),
          );
          if (patched === "refresh") return reread();
          const lacking = options.rereads?.(shown.value, reply) === true;
          const next = reuseUnchanged(shown.value, patched);
          if (next === shown.value)
            return lacking || (unrefreshed && pending !== undefined) ? reread() : undefined;
          yield* options.onAnswer?.(target, next, registry) ?? Effect.void;
          const mounted = [atom, reader].some(
            (shownBy) => (registry.getNodes().get(shownBy)?.listeners.size ?? 0) > 0,
          );
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
    return reader;
  };
}
