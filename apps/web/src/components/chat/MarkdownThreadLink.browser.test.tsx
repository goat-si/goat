import { EnvironmentId, ThreadId } from "@goat/contracts";
import { formatThreadLink } from "@goat/shared/threadLinks";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const state = vi.hoisted(() => ({
  keys: new Set<string>(),
  atoms: new Map<string, unknown>(),
  answers: {
    titles: {} as Record<string, string>,
    projectIds: {} as Record<string, string | null>,
  },
}));

// Records each lookup the links ask for; one key is one paged request (pages of 100).
vi.mock(import("@goat/client-runtime/state/thread-lineage-lookup"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createThreadLineageLookup: ((...args: Parameters<typeof actual.createThreadLineageLookup>) => ({
      ...actual.createThreadLineageLookup(...args),
      resolution: (environmentId: string, _anchor: string, ids: ReadonlyArray<string>) => {
        const key = JSON.stringify([environmentId, ids]);
        state.keys.add(key);
        let atom = state.atoms.get(key) as Atom.Atom<unknown> | undefined;
        if (atom === undefined) {
          const answered = ids.filter((id) => Object.hasOwn(state.answers.titles, id));
          atom = Atom.make({
            checked: new Set(ids),
            titles: Object.fromEntries(answered.map((id) => [id, state.answers.titles[id]])),
            projectIds: Object.fromEntries(
              answered.flatMap((id) =>
                Object.hasOwn(state.answers.projectIds, id)
                  ? [[id, state.answers.projectIds[id]]]
                  : [],
              ),
            ),
          });
          state.atoms.set(key, atom);
        }
        return atom;
      },
    })) as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: ((ref: { threadId: string } | null) =>
    ref?.threadId === "held"
      ? { id: "held", environmentId: "env", title: "Held thread", projectId: "project-1" }
      : null) as never,
  useEnvironmentThreadRefs: ((environmentId: string | null) =>
    environmentId === null ? [] : [{ environmentId, threadId: "held" }]) as never,
  useThreadRefs: (() => []) as never,
  useProject: ((ref: { projectId: string } | null) =>
    ref?.projectId === "project-1" ? { id: "project-1", title: "Project one" } : null) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../ProjectFavicon"), () => ({
  ProjectFavicon: ((props: { project: { title: string } }) => (
    <span data-testid="project-icon">{props.project.title}</span>
  )) as never,
}));

const environmentId = EnvironmentId.make("env");
const ids = ["alpha", "beta", "held"].map((id) => ThreadId.make(id));
const markdown = ids.map((id) => formatThreadLink(id, `Label ${id}`)).join(" and ");

function setup(answers: typeof state.answers) {
  state.keys.clear();
  state.atoms.clear();
  state.answers = answers;
}

function message() {
  return (
    <p>
      {ids.map((threadId) => (
        <MarkdownThreadLink
          key={threadId}
          environmentId={environmentId}
          threadId={threadId}
          label={`Label ${threadId}`}
          markdown={markdown}
        />
      ))}
    </p>
  );
}

it("a message's links to threads this client does not hold share one lookup and show their titles and projects", async () => {
  setup({
    titles: { alpha: "Alpha", beta: "Beta" },
    projectIds: { alpha: "project-1", beta: null },
  });
  await using screen = await render(message());

  await expect.element(screen.getByRole("link", { name: "Thread, Alpha" })).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Thread, Beta" })).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Thread, Held thread" })).toBeVisible();
  // One key for the two unheld links; the held thread is never asked.
  expect([...state.keys]).toEqual([JSON.stringify(["env", ["alpha", "beta"]])]);
  // Alpha's project is held; Beta's project is gone, so Beta shows no project icon.
  expect(
    screen
      .getByTestId("project-icon")
      .elements()
      .map((icon) => icon.textContent),
  ).toEqual(["Project one", "Project one"]);
});

it("an older server's titles without projects show the title only, and an unanswered link keeps its label", async () => {
  setup({ titles: { alpha: "Alpha" }, projectIds: {} });
  await using screen = await render(message());

  await expect.element(screen.getByRole("link", { name: "Thread, Alpha" })).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Thread, Label beta" })).toBeVisible();
  expect(
    screen
      .getByTestId("project-icon")
      .elements()
      .map((icon) => icon.textContent),
  ).toEqual(["Project one"]);
});
