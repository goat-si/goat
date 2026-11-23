import { RunId } from "@goat/contracts";
import { GTProvider } from "gt-react";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import chinese from "../../i18n/translations/zh.json";
import { MessagesTimeline } from "./MessagesTimeline";
import { baseProps, message } from "./MessagesTimeline.browserHarness";

it("shows the elapsed work heading in the selected language", async () => {
  const runId = RunId.make("completed-run");
  await using screen = await render(
    <GTProvider locale="zh" translations={{ zh: chinese }}>
      <MessagesTimeline
        {...baseProps()}
        timelineEntries={[
          message("Progress", { role: "assistant", runId }, "progress"),
          message("Done", { role: "assistant", runId }, "final"),
        ]}
      />
    </GTProvider>,
  );
  await expect.element(screen.getByRole("button", { name: /^耗时 .+s$/ })).toBeVisible();
});
