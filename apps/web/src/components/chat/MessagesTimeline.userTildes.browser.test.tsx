import { expect, it } from "vite-plus/test";
import "~/index.css";
import { message, renderTimeline } from "./MessagesTimeline.browserHarness";

it("keeps single tildes in user paths literal without changing double tildes or assistant text", async () => {
  const source =
    "Install the skill as ~/folder-a/skills/x, then follow the guide (~/folder-a/guide.md).";
  await using screen = await renderTimeline([
    message(source),
    message("Drop ~~the old plan~~", {}, "message-2"),
    message(source, { role: "assistant" }, "assistant-1"),
  ]);
  const [user, doubleTilde, assistant] = screen.container.querySelectorAll<HTMLElement>(
    "[data-timeline-row-kind=message]",
  );
  expect(user?.textContent).toContain(source);
  expect(user?.querySelector("del")).toBeNull();
  expect(doubleTilde?.querySelector("del")?.textContent).toBe("the old plan");
  expect(assistant?.querySelector("del")?.textContent).toBe(
    "/folder-a/skills/x, then follow the guide (",
  );
});
