import type { ChangeRequestTerminology } from "@goat/client-runtime/source-control-clients";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestListEntry,
  type PullRequestSummary,
} from "@goat/contracts";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useContext, useCallback, useLayoutEffect, useMemo, useState } from "react";

import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import {
  getCachedPullRequestDiffPages,
  retainPullRequestDiffPage,
  type PullRequestDiffPage,
  withWithheldFiles,
  type WithheldFileLoad,
} from "./pullRequestDiffPages";

export type PullRequestParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
  readonly initialSummary?: PullRequestListEntry | PullRequestSummary;
};

export type PullRequestDiffParams = PullRequestParams & { readonly commit?: string };

export function pullRequestTarget(params: PullRequestParams) {
  return {
    environmentId: EnvironmentId.make(params.environmentId),
    input: {
      projectId: ProjectId.make(params.projectId),
      repository: params.repository,
      number: params.number,
      ...(params.host ? { host: params.host } : {}),
    },
  };
}

const NO_PATHS: readonly string[] = [];
const NO_WITHHELD_ANSWERS = Atom.make(() => []);
const NO_PAGES: readonly PullRequestDiffPage[] = [];

export function usePullRequestDiffEntry(navigation: {
  readonly addListener: (
    type: "transitionStart" | "transitionEnd",
    listener: (event: { readonly data: { readonly closing: boolean } }) => void,
  ) => () => void;
}) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (ready) return;
    let opening = false;
    let closing = false;
    const finish = () => {
      if (!closing) setReady(true);
    };
    const removeStart = navigation.addListener("transitionStart", ({ data }) => {
      closing = data.closing;
      if (!closing) opening = true;
    });
    const removeEnd = navigation.addListener("transitionEnd", ({ data }) => {
      closing = data.closing;
      if (!closing) finish();
    });
    // Initial and unanimated presentations may have no transition events; let the shell paint first.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!opening) finish();
      });
    });
    // A missing native completion must not strand the route on its loading state.
    const fallback = setTimeout(finish, 1_000);
    return () => {
      removeStart();
      removeEnd();
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
    };
  }, [navigation, ready]);
  return ready;
}

export function usePullRequestDiff(
  params: PullRequestDiffParams,
  terminology: ChangeRequestTerminology,
) {
  const reference = pullRequestTarget(params);
  const target = {
    ...reference,
    input: { ...reference.input, ...(params.commit ? { commit: params.commit } : {}) },
  };
  const key = JSON.stringify(target);
  const firstPageAtom = composerPullRequests.diff(target);
  const refreshFirstPage = useAtomRefresh(firstPageAtom);
  const { refreshing, onRefresh } = usePullToRefresh(firstPageAtom);
  const [state, setState] = useState<{
    key: string;
    cursor: string | null;
    pages: readonly PullRequestDiffPage[];
  }>({ key, cursor: null, pages: NO_PAGES });
  const cursor = state.key === key ? state.cursor : null;
  const query = useEnvironmentQuery(
    composerPullRequests.diff({
      ...target,
      input: { ...target.input, ...(cursor ? { cursor } : {}) },
    }),
  );
  const loaded = state.key === key ? state.pages : NO_PAGES;
  const pages = query.data ? retainPullRequestDiffPage(loaded, cursor, query.data) : loaded;
  if (state.key !== key || state.pages !== pages) setState({ key, cursor, pages });

  const paged = getCachedPullRequestDiffPages(pages, key, terminology);
  const firstPage = pages[0]?.result;
  const revision = firstPage?.revision;
  const fileTarget = params.commit ? target : { ...target, input: { ...target.input, revision } };
  const fileKey = JSON.stringify(fileTarget);
  const [loads, setLoads] = useState({ key: fileKey, paths: NO_PATHS });
  const paths = loads.key === fileKey ? loads.paths : NO_PATHS;
  const readable =
    firstPage?.withheldFilesReadable === true && (!!params.commit || revision !== undefined);
  const registry = useContext(RegistryContext);
  const answers = useAtomValue(
    paths.length === 0
      ? NO_WITHHELD_ANSWERS
      : composerPullRequests.withheldDiffs(JSON.stringify({ target: fileTarget, paths })),
  );
  const refreshWithheldFile = (path: string) =>
    registry.refresh(
      composerPullRequests.withheldDiff({
        ...fileTarget,
        input: { ...fileTarget.input, path },
      }),
    );
  const loadWithheldFile = (path: string) => {
    if (!readable) return;
    refreshWithheldFile(path);
    if (!paths.includes(path)) setLoads({ key: fileKey, paths: [...paths, path] });
  };
  const withheldRefetching = answers.some((result) => result.waiting);
  const parsed = useMemo(() => {
    if (!paged) return paged;
    const states = new Map<string, WithheldFileLoad>();
    paths.forEach((path, index) => {
      const answer = answers[index];
      if (answer?._tag === "Success" && !answer.waiting) {
        states.set(path, { status: "loaded", result: answer.value });
      } else {
        states.set(path, {
          status: answer?._tag === "Failure" && !answer.waiting ? "error" : "loading",
        });
      }
    });
    return withWithheldFiles(paged, states, readable, fileKey);
  }, [answers, fileKey, paged, paths, readable]);
  const patch = useMemo(() => pages.map((page) => page.result.patch).join("\n"), [pages]);
  const nextCursor = pages.at(-1)?.result.nextCursor ?? null;
  const canLoadMore =
    nextCursor !== null && nextCursor !== cursor && !query.isPending && query.error === null;
  const loadMore = useCallback(() => {
    if (!canLoadMore) return;
    setState({ key, cursor: nextCursor, pages });
  }, [canLoadMore, key, nextCursor, pages, setState]);
  const { error, refresh: refreshPage } = query;
  const refresh = useCallback(() => {
    if (cursor !== null && error !== null) {
      refreshPage();
      return;
    }
    setState({ key, cursor: null, pages: NO_PAGES });
    paths.forEach(refreshWithheldFile);
    refreshFirstPage();
  }, [cursor, error, refreshPage, key, paths, refreshWithheldFile, refreshFirstPage, setState]);
  const onPullRefresh = useCallback(() => {
    setState({ key, cursor: null, pages: NO_PAGES });
    paths.forEach(refreshWithheldFile);
    onRefresh();
  }, [key, onRefresh, paths, refreshWithheldFile, setState]);
  return {
    ...query,
    refresh,
    parsed,
    loadWithheldFile,
    withheldRefetching,
    patch,
    nextCursor,
    canLoadMore,
    loadMore,
    refreshing,
    onPullRefresh,
  };
}
