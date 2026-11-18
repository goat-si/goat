import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectSearchContentsError,
  type ProjectSearchContentsResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { useProjectContentSearch } from "./queries";

const read = vi.hoisted(() =>
  vi.fn<
    (query: string) => Effect.Effect<ProjectSearchContentsResult, ProjectSearchContentsError>
  >(),
);

vi.mock("./filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));

vi.mock("./projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const response = Atom.family((query: string) => Atom.make(Effect.suspend(() => read(query))));
  return {
    projectEnvironment: {},
    projectContentSearch: ({ input }: { input: { query: string } }) => response(input.query),
  };
});

function Probe({ query }: { readonly query: string }) {
  const search = useProjectContentSearch({
    environmentId: EnvironmentId.make("test-environment"),
    cwd: "/workspace",
    query,
    caseSensitive: true,
    wholeWord: false,
    useRegex: false,
  });
  return <output>{search.isPending ? "searching" : search.error ? "timed out" : "ready"}</output>;
}

it("retries a settled content timeout and cancels the retry when the query changes", async () => {
  read.mockReset();
  const timedOut = (query: string) =>
    Effect.fail(
      new ProjectSearchContentsError({
        cwd: "/workspace",
        queryLength: query.length,
        limit: 500,
        failure: "search_index_scan_timed_out",
      }),
    );
  const ready = Effect.succeed({ matches: [], truncated: false });
  let firstReads = 0;
  read.mockImplementation((query) => {
    if (query === "first" && firstReads++ === 0) return timedOut(query);
    return query === "cancelled" ? timedOut(query) : ready;
  });

  const registry = AtomRegistry.make();
  const view = (query: string) => (
    <RegistryContext.Provider value={registry}>
      <Probe query={query} />
    </RegistryContext.Provider>
  );
  // The probe only exercises query and timer lifecycles.
  await using screen = await render(view(""), { router: false });
  using _timers = fakeTimers();
  const tick = (milliseconds: number) => act(() => vi.advanceTimersByTimeAsync(milliseconds));
  const readQueries = () => read.mock.calls.map(([query]) => query);
  const status = () => screen.getByRole("status").element().textContent;

  await screen.rerender(view("first"));
  await tick(120);
  expect(status()).toBe("timed out");
  await tick(29_999);
  expect(readQueries()).toEqual(["first"]);

  await tick(1);
  expect(readQueries()).toEqual(["first", "first"]);
  expect(status()).toBe("ready");

  await screen.rerender(view("cancelled"));
  await tick(120);
  expect(status()).toBe("timed out");
  await screen.rerender(view("next"));
  await tick(30_000);
  expect(readQueries()).toEqual(["first", "first", "cancelled", "next"]);
  expect(status()).toBe("ready");
});
