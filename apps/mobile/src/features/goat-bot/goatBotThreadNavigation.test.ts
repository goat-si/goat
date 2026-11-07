import * as NodeModule from "node:module";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import {
  selectWorkspaceDetail,
  workspaceDetailRouter,
} from "../workspace/workspace-detail-selection";
import { openBotThreadAction } from "./goatBotThreadNavigation";

const requireFromNative = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const requireFromCore = NodeModule.createRequire(
  requireFromNative.resolve("@react-navigation/core/package.json"),
);
const { StackRouter } = requireFromCore("@react-navigation/routers") as {
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};

const base = StackRouter({});
const router = { ...base, ...workspaceDetailRouter(base) };
const options = {
  routeNames: ["Home", "GoatBot", "Thread"],
  routeParamList: {},
  routeGetIdList: {},
};
type State = ReturnType<typeof base.getInitialState>;
type RouterAction = Parameters<typeof base.getStateForAction>[1];

function apply(state: State, action: object) {
  const next = router.getStateForAction(state, action as RouterAction, options);
  if (!next) throw new Error("Router rejected the action");
  return base.getRehydratedState(next as State, options);
}

it("Back from a coding thread opened in a member bot's work returns to that bot", () => {
  const echo = apply(
    base.getInitialState(options),
    selectWorkspaceDetail({ name: "GoatBot", params: { botId: "echo" } }),
  );
  const task = apply(echo, {
    type: "PUSH",
    payload: { name: "GoatBot", params: { taskId: "turn", botId: "echo" } },
  });
  const thread = apply(
    task,
    openBotThreadAction({ environmentId: EnvironmentId.make("env"), id: ThreadId.make("child") }),
  );
  expect(thread.routes.map((route) => route.name)).toEqual([
    "Home",
    "GoatBot",
    "GoatBot",
    "Thread",
  ]);
  expect(thread.routes.at(-1)?.params).toEqual({ environmentId: "env", threadId: "child" });

  const back = apply(thread, { type: "GO_BACK" });
  expect(back.routes.at(-1)?.params).toEqual({ taskId: "turn", botId: "echo" });
});
