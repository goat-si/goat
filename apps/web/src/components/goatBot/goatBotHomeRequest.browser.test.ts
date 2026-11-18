import { createBrowserHistory } from "@tanstack/react-router";
import { ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { goatBotHomeKey, rememberHomeOrigin } from "./goatBotHomeRequest";

it("keeps the Home origin on the browser entry when a link navigates in the same tick", async () => {
  const history = createBrowserHistory();
  try {
    history.push("/origin");
    await vi.waitFor(() => expect(window.location.pathname).toBe("/origin"));
    rememberHomeOrigin(
      { state: { location: { href: "/origin", state: history.location.state } }, history },
      EnvironmentId.make("env"),
      null,
      ChannelTaskId.make("task-a"),
    );
    history.push("/work-thread");
    await vi.waitFor(() => expect(window.location.pathname).toBe("/work-thread"));
    history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/origin"));
    expect(window.history.state?.goatBotOpenHome).toEqual({
      key: goatBotHomeKey(EnvironmentId.make("env"), null),
      taskId: "task-a",
    });
  } finally {
    history.destroy();
  }
});
