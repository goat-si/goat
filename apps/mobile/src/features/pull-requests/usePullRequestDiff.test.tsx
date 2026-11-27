import { RegistryContext } from "@effect/atom-react";
import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import type { PullRequestDiffResult } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ diff: vi.fn(), withheldDiffAdvertised: vi.fn() }));
vi.mock("../../state/pull-requests", () => ({ composerPullRequests: mocks }));

import {
  pullRequestParams,
  usePullRequestDiff,
  usePullRequestDiffEntry,
} from "./usePullRequestDiff";
import * as reviewModel from "../review/reviewModel";
import { getCachedNativeReviewDiffData } from "../review/nativeReviewDiffAdapter";

function patch(
  path: string,
  nextCursor: string | null = null,
  added = "new",
): PullRequestDiffResult {
  return {
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${added}\n`,
    truncated: false,
    nextCursor,
  };
}

interface WithheldViewState {
  readonly staleDiff?: boolean;
  readonly headSha?: string;
}

function setup(initial: WithheldViewState = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  const requests: {
    cursor: string | null;
    resolve: (value: PullRequestDiffResult) => void;
    reject: (error: Error) => void;
  }[] = [];
  const queries = Atom.family((cursor: string | null) =>
    Atom.make(
      Effect.tryPromise(
        () =>
          new Promise<PullRequestDiffResult>((resolve, reject) => {
            requests.push({ cursor, resolve, reject });
          }),
      ),
    ).pipe(Atom.keepAlive),
  );
  mocks.diff.mockImplementation((target: { input: { cursor?: string } }) =>
    queries(target.input.cursor ?? null),
  );
  const advertised = Atom.make(() => true);
  mocks.withheldDiffAdvertised.mockReturnValue(advertised);
  const root = createRoot(document.createElement("div"));
  let current: ReturnType<typeof usePullRequestDiff>;
  function Probe(viewState: WithheldViewState) {
    const result = usePullRequestDiff(
      {
        environmentId: "environment",
        projectId: "project",
        repository: "repo",
        number: 1,
      },
      sourceControlClients.get("github").changeRequest,
      viewState,
    );
    useLayoutEffect(() => {
      current = result;
    });
    return null;
  }
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe {...initial} />
      </RegistryContext.Provider>,
    ),
  );
  return {
    requests,
    update(viewState: WithheldViewState) {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <Probe {...viewState} />
          </RegistryContext.Provider>,
        ),
      );
    },
    remount() {
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <Probe key="new-route" />
          </RegistryContext.Provider>,
        ),
      );
    },
    get current() {
      return current;
    },
    async succeed(index: number, result: PullRequestDiffResult) {
      await act(async () => {
        requests[index]!.resolve(result);
      });
    },
    async fail(index: number) {
      await act(async () => {
        requests[index]!.reject(new Error("Connection lost"));
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("reuses the parsed snapshot when a new route reads the same query result", async () => {
  using parse = vi.spyOn(reviewModel, "buildReviewParsedDiff");
  using screen = setup();
  await screen.succeed(0, patch("first.ts"));
  const parsed = screen.current.parsed;
  const parses = parse.mock.calls.length;
  screen.remount();
  expect(screen.current.parsed).toBe(parsed);
  expect(parse).toHaveBeenCalledTimes(parses);
  expect(screen.requests).toHaveLength(1);
});

function setupEntry() {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const requestFrame = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
  const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    if (id != null) frames.delete(id);
  });
  const listeners = new Map<string, (event: { data: { closing: boolean } }) => void>();
  const navigation = {
    addListener(
      type: "transitionStart" | "transitionEnd",
      listener: (event: { data: { closing: boolean } }) => void,
    ) {
      listeners.set(type, listener);
      return () => {
        listeners.delete(type);
      };
    },
  };
  const events: string[] = [];
  const prepare = vi.fn(() => {
    events.push("prepare");
    return getCachedNativeReviewDiffData({
      parsedDiff: reviewModel.buildReviewParsedDiff(
        patch("first.ts").patch + patch("neighbor.ts").patch,
        "entry",
      ),
    });
  });
  function Body() {
    const [data] = useState(prepare);
    return <div>{data.files.map((file) => file.path).join(",")}</div>;
  }
  function Entry() {
    const ready = usePullRequestDiffEntry(navigation);
    useLayoutEffect(() => {
      events.push(ready ? "body-commit" : "shell-commit");
    }, [ready]);
    return ready ? <Body /> : <div>Opening changes</div>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Entry />));
  return {
    prepare,
    events,
    container,
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      act(() => {
        for (const callback of pending) callback(0);
      });
    },
    event(type: "transitionStart" | "transitionEnd", closing = false) {
      act(() => listeners.get(type)?.({ data: { closing } }));
    },
    fallback() {
      act(() => vi.runAllTimers());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
    },
  };
}

it("commits the loading shell and waits for the opening transition before building the diff", () => {
  using screen = setupEntry();
  expect(screen.events).toEqual(["shell-commit"]);
  screen.event("transitionStart");
  screen.frame();
  screen.frame();
  screen.event("transitionEnd", true);
  expect(screen.prepare).not.toHaveBeenCalled();
  screen.event("transitionEnd");
  expect(screen.events).toEqual(["shell-commit", "prepare", "body-commit"]);
  expect(screen.container.textContent).toBe("first.ts,neighbor.ts");
});

it.each(["unanimated", "missing-completion"] as const)(
  "opens the diff after a %s presentation without stranding the shell",
  (presentation) => {
    using screen = setupEntry();
    if (presentation === "missing-completion") screen.event("transitionStart");
    screen.frame();
    expect(screen.prepare).not.toHaveBeenCalled();
    screen.frame();
    if (presentation === "missing-completion") {
      expect(screen.prepare).not.toHaveBeenCalled();
      screen.fallback();
    }
    expect(screen.prepare).toHaveBeenCalledOnce();
  },
);

it("retries a failed continuation without discarding loaded files or restarting page one", async () => {
  using screen = setup();
  await screen.succeed(0, patch("first.ts", "second"));
  act(() => screen.current.loadMore());
  await screen.fail(1);
  expect(screen.current.error).not.toBeNull();
  expect(screen.current.patch).toContain("first.ts");

  act(() => screen.current.retry());
  expect(screen.requests.map((request) => request.cursor)).toEqual([null, "second", "second"]);
  expect(screen.current.patch).toContain("first.ts");
  await screen.succeed(2, patch("second.ts"));
  expect(screen.current.error).toBeNull();
  expect(screen.current.parsed.kind).toBe("files");
  if (screen.current.parsed.kind !== "files") throw new Error("Expected files");
  expect(screen.current.parsed.files.map((file) => file.path)).toEqual(["first.ts", "second.ts"]);
  expect(screen.current.nextCursor).toBeNull();
});

it.each(["failed", "loaded"] as const)(
  "reloads every page from page one after a continuation %s",
  async (continuation) => {
    using screen = setup();
    await screen.succeed(0, patch("first.ts", "second"));
    act(() => screen.current.loadMore());
    if (continuation === "failed") await screen.fail(1);
    else await screen.succeed(1, patch("second.ts"));

    act(() => screen.current.refresh());
    expect(screen.requests.map((request) => request.cursor)).toEqual([null, "second", null]);
    // The page already on screen stays there while its replacement loads.
    expect(screen.current.patch).toContain("+new");
    expect(screen.current.patch).not.toContain("second.ts");
    expect(screen.current.canLoadMore).toBe(false);
    await screen.succeed(2, patch("first.ts", "second", "pushed"));
    expect(screen.current.error).toBeNull();
    expect(screen.current.patch).not.toContain("+new");

    act(() => screen.current.loadMore());
    expect(screen.requests.map((request) => request.cursor)).toEqual([
      null,
      "second",
      null,
      "second",
    ]);
    expect(screen.current.isPending).toBe(true);
    await screen.succeed(3, patch("second.ts", null, "pushed"));
    expect(screen.current.patch).not.toContain("+new");
    if (screen.current.parsed.kind !== "files") throw new Error("Expected files");
    expect(screen.current.parsed.files.map((file) => file.path)).toEqual(["first.ts", "second.ts"]);
  },
);

it("holds further pages back until a pull to refresh has reread page one", async () => {
  using screen = setup();
  await screen.succeed(0, patch("first.ts", "second"));

  // The pull's refetch starts a tick later, so page one still looks settled here.
  act(() => void screen.current.onPullRefresh());
  expect(screen.current.patch).toContain("first.ts");
  expect(screen.current.canLoadMore).toBe(false);
  act(() => screen.current.loadMore());
  await act(async () => {});
  expect(screen.requests.map((request) => request.cursor)).toEqual([null, null]);

  await screen.succeed(1, patch("first.ts", "second", "pushed"));
  expect(screen.current.patch).toContain("+pushed");
  expect(screen.current.canLoadMore).toBe(true);
});

it("disables a withheld notice until the page catches up to the new head", async () => {
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const page = (headSha: string): PullRequestDiffResult => ({
    patch: "diff --git a/large.js b/large.js\n--- a/large.js\n+++ b/large.js\n",
    truncated: true,
    nextCursor: null,
    omittedFileStats: [{ path: "large.js", additions: 2, deletions: 0 }],
    withheldFilesReadable: true,
    revision: { baseSha: "c".repeat(40), headSha },
  });
  using screen = setup({ headSha: oldHead });
  const canTap = () => {
    const parsed = screen.current.parsed;
    if (parsed.kind !== "files") throw new Error("Expected a withheld file");
    return parsed.files[0]?.noticeActionable;
  };
  await screen.succeed(0, page(oldHead));
  expect(canTap()).toBe(true);

  screen.update({ headSha: newHead, staleDiff: true });
  expect(canTap()).toBe(false);
  screen.update({ headSha: newHead, staleDiff: false });
  expect(canTap()).toBe(false);

  act(() => screen.current.refresh());
  await screen.succeed(1, page(newHead));
  expect(canTap()).toBe(true);
});

it("keeps only the pull request a route names", () => {
  const pullRequest = {
    environmentId: "environment",
    projectId: "project",
    repository: "owner/repo",
    number: 1,
    host: "git.example.com",
    navigationUrl: "https://git.example.com/owner/repo/pull/1#discussion_r1",
    navigationId: 2,
  };
  const routeParams = { ...pullRequest, commit: "abc1234", path: "src/index.ts" };
  expect(pullRequestParams(routeParams)).toEqual(pullRequest);
});
