import { retainWithheldDiffPaths } from "@goat/client-runtime/state/pull-requests";
import type { ChangeRequestTerminology } from "@goat/client-runtime/source-control-clients";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestListEntry,
  type PullRequestSummary,
} from "@goat/contracts";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Atom, type AsyncResult } from "effect/reactivity";
import { useContext, useLayoutEffect, useMemo, useState } from "react";

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
  readonly navigationUrl?: string;
  readonly navigationId?: number;
  readonly initialSummary?: PullRequestListEntry | PullRequestSummary;
};

export type PullRequestDiffParams = PullRequestParams & { readonly commit?: string };

/** The pull request a route names, without whatever else arrived on that route. */
export function pullRequestParams(params: PullRequestParams): PullRequestParams {
  return {
    environmentId: params.environmentId,
    projectId: params.projectId,
    repository: params.repository,
    number: params.number,
    ...(params.host === undefined ? {} : { host: params.host }),
    ...(params.navigationUrl === undefined ? {} : { navigationUrl: params.navigationUrl }),
    ...(params.navigationId === undefined ? {} : { navigationId: params.navigationId }),
    ...(params.initialSummary === undefined ? {} : { initialSummary: params.initialSummary }),
  };
}

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
const UNADVERTISED = Atom.make(() => false);
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
  view: { readonly staleDiff?: boolean; readonly headSha?: string | undefined } = {},
) {
  const reference = pullRequestTarget(params);
  const target = {
    ...reference,
    input: { ...reference.input, ...(params.commit ? { commit: params.commit } : {}) },
  };
  const key = JSON.stringify(target);
  const firstPageAtom = composerPullRequests.diff(target);
  const currentFirstPage = useEnvironmentQuery(firstPageAtom).data;
  const firstPageResult = useAtomValue(firstPageAtom);
  const registry = useContext(RegistryContext);
  const refreshFirstPage = useAtomRefresh(firstPageAtom);
  const { refreshing, onRefresh } = usePullToRefresh(firstPageAtom);
  const [state, setState] = useState<{
    key: string;
    cursor: string | null;
    pages: readonly PullRequestDiffPage[];
    reloadedFrom?: AsyncResult.AsyncResult<unknown, unknown>;
  }>({ key, cursor: null, pages: NO_PAGES });
  const cursor = state.key === key ? state.cursor : null;
  const reloadedFrom = state.key === key ? state.reloadedFrom : undefined;
  const pageAtom = (pageCursor: string | null) =>
    composerPullRequests.diff({
      ...target,
      input: { ...target.input, ...(pageCursor ? { cursor: pageCursor } : {}) },
    });
  const query = useEnvironmentQuery(pageAtom(cursor));
  const loaded = state.key === key ? state.pages : NO_PAGES;
  const pages = query.data ? retainPullRequestDiffPage(loaded, cursor, query.data) : loaded;
  if (state.key !== key || state.pages !== pages) setState({ key, cursor, pages, reloadedFrom });

  const paged = getCachedPullRequestDiffPages(pages, key, terminology);
  const firstPage = pages[0]?.result ?? currentFirstPage;
  const revision = firstPage?.revision;
  const fileTarget = params.commit ? target : { ...target, input: { ...target.input, revision } };
  const fileKey = JSON.stringify(fileTarget);
  const [loads, setLoads] = useState({ key: fileKey, paths: NO_PATHS });
  const pageReadable =
    !view.staleDiff &&
    firstPage?.withheldFilesReadable === true &&
    (!!params.commit ||
      (revision !== undefined &&
        (view.headSha === undefined || revision.headSha === view.headSha.toLowerCase())));
  const readable = useAtomValue(
    pageReadable ? composerPullRequests.withheldDiffAdvertised(fileTarget) : UNADVERTISED,
  );
  const paths = readable && loads.key === fileKey ? loads.paths : NO_PATHS;
  const answers = useAtomValue(
    paths.length === 0
      ? NO_WITHHELD_ANSWERS
      : composerPullRequests.withheldDiffs(JSON.stringify({ target: fileTarget, paths })),
  );
  const retained = retainWithheldDiffPaths(paths, (index) => {
    const answer = answers[index];
    return answer?._tag === "Success" ? answer.value : undefined;
  });
  if (retained !== paths) setLoads({ key: fileKey, paths: retained });
  const offset = paths.length - retained.length;
  const loadWithheldFile = (path: string) => {
    if (!readable) return;
    if (retained.includes(path)) {
      registry.refresh(
        composerPullRequests.withheldDiff({
          ...fileTarget,
          input: { ...fileTarget.input, path },
        }),
      );
      return;
    }
    setLoads((current) => {
      const selected = current.key === fileKey ? current.paths : NO_PATHS;
      return selected.includes(path)
        ? current
        : {
            key: fileKey,
            paths: retainWithheldDiffPaths([...selected, path], () => undefined),
          };
    });
  };
  const loadedPaths = retained.filter((_, index) => answers[offset + index]?._tag === "Success");
  const withheldOverlayKey =
    loadedPaths.length === 0 ? undefined : JSON.stringify([fileKey, loadedPaths]);
  const withheldRefetching = answers.some((result) => result.waiting);
  const parsed = useMemo(() => {
    if (!paged) return paged;
    const states = new Map<string, WithheldFileLoad>();
    retained.forEach((path, index) => {
      const answer = answers[offset + index];
      if (answer?._tag === "Success" && !answer.waiting) {
        states.set(path, { status: "loaded", result: answer.value });
      } else {
        states.set(path, {
          status: answer?._tag === "Failure" && !answer.waiting ? "error" : "loading",
        });
      }
    });
    return withWithheldFiles(paged, states, readable, fileKey);
  }, [answers, fileKey, offset, paged, readable, retained]);
  const patch = useMemo(() => pages.map((page) => page.result.patch).join("\n"), [pages]);
  const nextCursor = pages.at(-1)?.result.nextCursor ?? null;
  const reloadStarting = reloadedFrom !== undefined && firstPageResult === reloadedFrom;
  const canLoadMore =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !query.isPending &&
    query.error === null &&
    !reloadStarting;
  const loadMore = () => {
    if (!canLoadMore) return;
    if (reloadedFrom !== undefined) registry.refresh(pageAtom(nextCursor));
    setState({ key, cursor: nextCursor, pages, reloadedFrom });
  };
  const reload = (refreshFirst: () => void) => {
    setState({ key, cursor: null, pages: NO_PAGES, reloadedFrom: firstPageResult });
    refreshFirst();
  };
  return {
    ...query,
    refresh: () => reload(refreshFirstPage),
    retry: query.refresh,
    parsed,
    loadWithheldFile,
    withheldRefetching,
    withheldOverlayKey,
    patch,
    nextCursor,
    canLoadMore,
    loadMore,
    refreshing,
    onPullRefresh: () => reload(onRefresh),
  };
}
