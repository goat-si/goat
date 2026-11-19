import { useAtomValue } from "@effect/atom-react";
import { heldPullRequestListEntriesAtom } from "@goat/client-runtime/state/pull-requests";
import type { PullRequestListInput } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";

const heldRowReaders = new WeakMap<
  EnvironmentPullRequestEntry,
  Map<string, ReturnType<typeof heldPullRequestListEntriesAtom<EnvironmentPullRequestEntry>>>
>();

export function usePendingListEntries(
  input: PullRequestListInput,
  entries: ReadonlyArray<EnvironmentPullRequestEntry> | undefined,
) {
  const key = JSON.stringify(input);
  return useAtomValue(
    Atom.make((get) =>
      (entries ?? []).flatMap((entry) => {
        let readers = heldRowReaders.get(entry);
        if (readers === undefined) {
          readers = new Map();
          heldRowReaders.set(entry, readers);
        }
        let reader = readers.get(key);
        if (reader === undefined) {
          reader = heldPullRequestListEntriesAtom(entry.environmentId, input, [entry]);
          readers.set(key, reader);
        }
        return AsyncResult.getOrElse(get(reader), () => []);
      }),
    ),
  );
}

export function usePendingListGroups(
  input: PullRequestListInput,
  known: ReadonlyArray<EnvironmentPullRequestEntry>,
  baseline: ReadonlyArray<EnvironmentPullRequestEntry> | undefined,
  authored: ReadonlyArray<EnvironmentPullRequestEntry> | undefined,
  reviewing: ReadonlyArray<EnvironmentPullRequestEntry> | undefined,
  held:
    | {
        readonly authored: ReadonlyArray<EnvironmentPullRequestEntry>;
        readonly reviewing: ReadonlyArray<EnvironmentPullRequestEntry>;
      }
    | undefined,
) {
  const shownKnown = usePendingListEntries(input, known);
  const shownBaseline = usePendingListEntries(input, baseline);
  const shownAuthored = usePendingListEntries(input, authored);
  const shownReviewing = usePendingListEntries(input, reviewing);
  const heldAuthored = usePendingListEntries(input, held?.authored);
  const heldReviewing = usePendingListEntries(input, held?.reviewing);
  return {
    known: shownKnown,
    baseline: baseline === undefined ? undefined : shownBaseline,
    authored: authored === undefined ? undefined : shownAuthored,
    reviewing: reviewing === undefined ? undefined : shownReviewing,
    held: held === undefined ? undefined : { authored: heldAuthored, reviewing: heldReviewing },
  };
}
