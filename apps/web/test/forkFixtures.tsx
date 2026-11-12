import { createMemoryHistory } from "@tanstack/react-router";
import {
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  PlanId,
  type OrchestrationV2ThreadForkInput,
} from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { ENVIRONMENT_ID, rpcRequests, threadWithHistory, type FakeThread } from "./fakeEnvironment";
import { render } from "./render";

// The app keeps its connection, and with it the first shell and server config, for the whole
// file, so a file installs one fixture list and one capability set in every test.

export const FORK = ORCHESTRATION_V2_WS_METHODS.forkThread;
const DISPATCH = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;

/** A thread with one finished turn; fork commands of one thread run one after another. */
export function forkSource(name: string) {
  const thread = threadWithHistory(name, 1);
  const run = thread.runs[0];
  if (run === undefined) throw new Error("threadWithHistory made no run");
  return { thread, run };
}

/** A thread in plan mode whose last turn proposed a plan that waits for an answer. */
export function withProposedPlan(source: ReturnType<typeof forkSource>): FakeThread {
  return {
    ...source.thread,
    shell: { interactionMode: "plan" },
    plans: [
      {
        id: PlanId.make(`${source.thread.id}-plan`),
        threadId: source.thread.id,
        runId: source.run.id,
        nodeId: NodeId.make(`${source.thread.id}-node`),
        status: "active",
        kind: "proposed_plan",
        markdown: "# Plan\n\n- Do the thing",
      },
    ],
  };
}

export const forkRequests = () =>
  rpcRequests(FORK) as ReadonlyArray<OrchestrationV2ThreadForkInput>;

// Opening a thread records a visit; only the commands a fork could send matter here.
export const dispatched = () =>
  (rpcRequests(DISPATCH) as ReadonlyArray<{ readonly type: string }>).filter(
    ({ type }) => type !== "thread.visit",
  );
export const dispatchedTypes = () => dispatched().map(({ type }) => type);

/** Answers dispatches and forks, so no command stays pending into the next test. */
export const answerForks = {
  [DISPATCH]: () => Effect.succeed({ sequence: 1 }),
  [FORK]: (input: OrchestrationV2ThreadForkInput) =>
    Effect.succeed({ sequence: 2, targetThreadId: input.targetThreadId }),
};

export async function openThread(thread: FakeThread) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  const screen = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  return screen;
}

export const composerEditor = () => page.getByTestId("composer-editor");
