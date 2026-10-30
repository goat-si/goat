import { RunId } from "@goat/contracts";
import { it } from "vite-plus/test";
import { buildThreadFeed, deriveThreadFeedPresentation } from "./threadActivity";
import * as helpers from "./threadActivity.test.helpers";
it("scratch", () => {
  const out: string[] = [];
  const { projected, userMessage, command, assistantMessage, runId } = helpers;
  const running = { status: "running" as const, completedAt: null };
  const items = [
    projected(userMessage(), 0),
    projected({ ...command(), ...running }, 1),
    projected({ ...assistantMessage(), ...running, text: "partial", streaming: true }, 2),
  ];
  const cases = {
    activeRun: {
      runId,
      status: "running" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: null,
    },
    noRun: null,
    staleRun: {
      runId: RunId.make("run-0"),
      status: "completed" as const,
      startedAt: "2026-06-19T00:00:01.000Z",
      completedAt: "2026-06-19T00:01:00.000Z",
    },
  };
  for (const [name, latestRun] of Object.entries(cases)) {
    const rows = deriveThreadFeedPresentation(
      buildThreadFeed(items),
      latestRun,
      new Set(),
      new Set(),
      "2026-06-20T00:00:01.000Z",
    );
    out.push(
      name +
        ": " +
        rows
          .map(
            (r) =>
              r.type + (r.type === "message" ? ":" + r.message.role + ":" + r.message.text : ""),
          )
          .join(", "),
    );
  }
  process.stdout.write("\n" + out.join("\n") + "\n");
});
