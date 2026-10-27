import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestListInput } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { use, useCallback, useMemo, useRef, useState, useLayoutEffect } from "react";
import {
  composerPullRequests,
  pullRequestListPagesFamily as pagesFamily,
  pullRequestListStatsFamily as statsFamily,
} from "../../state/pull-requests";
import {
  appendPullRequestListPage,
  mergeEnvironmentPullRequestPages,
  nextPullRequestListInput,
  pullRequestListHead,
  patchPullRequestListEntry,
  pullRequestStatKey as statKey,
  withShownPullRequestStats,
  scopedPullRequestListKey,
  type EnvironmentPullRequestListEntry,
} from "./pullRequestList";

type ListTarget = { readonly environmentId: EnvironmentId; readonly input: PullRequestListInput };
const sourcesFamily = Atom.family((key: string) => {
  const targets: readonly ListTarget[] = JSON.parse(key);
  return Atom.make((get) =>
    targets.map((target) => {
      const result = get(composerPullRequests.list(target));
      const head = Option.getOrNull(AsyncResult.value(result));
      const cached = get(pagesFamily(JSON.stringify(target)));
      return {
        target,
        result,
        pages: head ? pullRequestListHead(cached, head) : cached,
        stats: get(statsFamily(target.environmentId)),
      };
    }),
  );
});

export function usePullRequestList(targets: readonly ListTarget[]) {
  const registry = use(RegistryContext);
  const scopeKey = JSON.stringify(targets);
  const activeScope = useRef(scopeKey);
  const sources = useAtomValue(sourcesFamily(scopeKey));
  const requests = useRef<{ page?: AbortController; refresh?: AbortController }>({});
  const [loading, setLoading] = useState({
    key: scopeKey,
    page: false,
    refresh: false,
    error: null as string | null,
  });
  const state = loading.key === scopeKey ? loading : { page: false, refresh: false, error: null };
  useLayoutEffect(() => {
    activeScope.current = scopeKey;
    return () => {
      requests.current.page?.abort();
      requests.current.refresh?.abort();
      requests.current = {};
    };
  }, [scopeKey, activeScope]);

  const loadMore = useCallback(
    async (retry = false) => {
      if (requests.current.page || requests.current.refresh || (!retry && state.error)) return;
      const continuations = targets.flatMap((target) => {
        const pagesAtom = pagesFamily(JSON.stringify(target));
        const head = Option.getOrNull(
          AsyncResult.value(registry.get(composerPullRequests.list(target))),
        );
        const recorded = registry.get(pagesAtom);
        const pages = head ? pullRequestListHead(recorded, head) : recorded;
        const input = pages && nextPullRequestListInput(pages, target.input);
        return pages && input ? [{ target, pagesAtom, pages, input }] : [];
      });
      if (!continuations.length) return;
      const controller = new AbortController();
      requests.current.page = controller;
      setLoading({ key: scopeKey, page: true, refresh: false, error: null });
      const responses = await Promise.allSettled(
        continuations.map(async ({ target, pagesAtom, pages, input }) => {
          const response = await executeAtomQuery(
            registry,
            composerPullRequests.list({ ...target, input }),
            {
              signal: controller.signal,
              refresh: retry,
              reportFailure: false,
            },
          );
          if (controller.signal.aborted || activeScope.current !== scopeKey) return;
          if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          if (response.value.errors.length)
            throw new Error(response.value.errors.map((error) => error.message).join("\n"));
          const next = appendPullRequestListPage(
            registry.get(pagesAtom) ?? pages,
            response.value,
            input,
          );
          registry.set(pagesAtom, next);
          if (
            input.cursors &&
            Object.keys(next.nextCursors).length &&
            JSON.stringify(Object.entries(input.cursors).sort()) ===
              JSON.stringify(Object.entries(next.nextCursors).sort())
          )
            throw new Error("Couldn't advance the list. Try again.");
        }),
      );
      if (requests.current.page === controller) delete requests.current.page;
      if (!controller.signal.aborted && activeScope.current === scopeKey)
        setLoading({ key: scopeKey, page: false, refresh: false, error: requestErrors(responses) });
    },
    [targets, registry, scopeKey, state.error, activeScope],
  );

  const onRefresh = async () => {
    if (!targets.length || requests.current.refresh) return;
    requests.current.page?.abort();
    delete requests.current.page;
    const controller = new AbortController();
    requests.current.refresh = controller;
    setLoading({ key: scopeKey, page: false, refresh: true, error: null });
    const responses = await Promise.allSettled(
      targets.map(async (target) => {
        await composerPullRequests.invalidate.run(registry, {
          environmentId: target.environmentId,
          input: {},
        });
        if (controller.signal.aborted) return;
        const response = await executeAtomQuery(registry, composerPullRequests.list(target), {
          refresh: true,
          signal: controller.signal,
          reportFailure: false,
        });
        if (controller.signal.aborted || activeScope.current !== scopeKey) return;
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        registry.set(
          pagesFamily(JSON.stringify(target)),
          pullRequestListHead(null, response.value),
        );
      }),
    );
    if (requests.current.refresh === controller) delete requests.current.refresh;
    if (!controller.signal.aborted && activeScope.current === scopeKey)
      setLoading({ key: scopeKey, page: false, refresh: false, error: requestErrors(responses) });
  };

  const data = useMemo(
    () =>
      mergeEnvironmentPullRequestPages(
        sources.flatMap(({ target, pages, stats }) =>
          pages
            ? [
                {
                  environmentId: target.environmentId,
                  pages: {
                    ...pages,
                    entries: pages.entries.map((entry) => {
                      const stat = stats.get(statKey(entry));
                      return stat
                        ? { ...entry, additions: stat.additions, deletions: stat.deletions }
                        : entry;
                    }),
                  },
                },
              ]
            : [],
        ),
      ),
    [sources],
  );
  const [visible, setVisible] = useState<{
    key: string;
    rows: readonly EnvironmentPullRequestListEntry[];
  }>({ key: scopeKey, rows: [] });
  const onViewableItemsChanged = useCallback(
    ({
      viewableItems,
    }: {
      viewableItems: readonly { item: EnvironmentPullRequestListEntry; isViewable: boolean }[];
    }) => {
      const rows = viewableItems.filter((token) => token.isViewable).map((token) => token.item);
      setVisible((previous) =>
        previous.key === scopeKey &&
        previous.rows.map(scopedPullRequestListKey).join() ===
          rows.map(scopedPullRequestListKey).join()
          ? previous
          : { key: scopeKey, rows },
      );
    },
    [scopeKey],
  );
  const visibleRows =
    visible.key === scopeKey && visible.rows.length ? visible.rows : data.entries.slice(0, 8);
  const statsKey = JSON.stringify(
    targets.flatMap(({ environmentId }) => {
      const refs = visibleRows
        .filter((row) => {
          const base = data.entries.find(
            (entry) => scopedPullRequestListKey(entry) === scopedPullRequestListKey(row),
          );
          return base?.environmentId === environmentId && base.additions + base.deletions === 0;
        })
        .map(({ projectId, host, repository, number }) => ({
          projectId,
          host,
          repository,
          number,
        }));
      return refs.length ? [{ environmentId, input: { refs } }] : [];
    }),
  );
  const statsAtom = useMemo(() => {
    const queries: readonly Parameters<typeof composerPullRequests.listStats>[0][] =
      JSON.parse(statsKey);
    return Atom.make((get) =>
      queries.map((target) => ({
        environmentId: target.environmentId,
        result: get(composerPullRequests.listStats(target)),
      })),
    );
  }, [statsKey]);
  const counts = useAtomValue(statsAtom);
  const entries = useMemo(
    () =>
      withShownPullRequestStats(
        data.entries,
        counts.flatMap(({ environmentId, result }) => {
          const answer = Option.getOrNull(AsyncResult.value(result));
          return answer ? [{ environmentId, stats: answer.stats }] : [];
        }),
      ),
    [data.entries, counts],
  );

  const updateEntry = useCallback(
    (entry: EnvironmentPullRequestListEntry, patch: Partial<EnvironmentPullRequestListEntry>) => {
      const target = targets.find((target) => target.environmentId === entry.environmentId);
      if (!target) return;
      const pagesAtom = pagesFamily(JSON.stringify(target));
      const head = Option.getOrNull(
        AsyncResult.value(registry.get(composerPullRequests.list(target))),
      );
      const patched = patchPullRequestListEntry(
        registry.get(pagesAtom),
        head,
        entry,
        patch,
        Date.now(),
      );
      if (patched) registry.set(pagesAtom, patched);
      registry.refresh(composerPullRequests.list(target));
    },
    [registry, targets],
  );
  const errors = useMemo(
    () =>
      sources.flatMap(({ target, result }) => {
        if (result._tag !== "Failure") return [];
        const cause = Cause.squash(result.cause);
        return [
          {
            environmentId: target.environmentId,
            projectTitle: "",
            message: cause instanceof Error ? cause.message : "Couldn't load pull requests.",
          },
        ];
      }),
    [sources],
  );
  const listing = useMemo(
    () => ({ ...data, entries, errors: [...data.errors, ...errors] }),
    [data, entries, errors],
  );
  return {
    data: listing,
    entries,
    error: errors.map((error) => error.message).join("\n") || null,
    isPending: sources.some(({ result }) => result.waiting) && !data.entries.length,
    continued: data.continued,
    loadMore,
    onRefresh,
    onViewableItemsChanged,
    updateEntry,
    refreshing: state.refresh,
    loadingMore: state.page,
    loadMoreError: state.error,
    hasMore: sources.some(
      ({ pages, target }) => pages && nextPullRequestListInput(pages, target.input),
    ),
  };
}

function requestErrors(results: readonly PromiseSettledResult<unknown>[]) {
  return (
    results
      .flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason.message
                : "Couldn't load pull requests.",
            ]
          : [],
      )
      .join("\n") || null
  );
}
