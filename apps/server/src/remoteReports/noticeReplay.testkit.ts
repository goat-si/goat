import { RunId, ThreadId } from "@goat/contracts";

import { finishedWake, newLaunchWatch } from "../mcp/launchWatch.ts";
import { pressureNudgeText } from "../fleet/pressure/pressureModel.ts";
import { framePendingReports, frameRemoteReport } from "./reportFrame.ts";

/**
 * A synthetic overnight supervisor stream, shaped like the one that prompted the context diet:
 * about 30 lanes on four machines, each sending progress reports, a completed report, and a run
 * end, with pressure notices in between. All text is invented. The replay models today's delivery:
 * each wake is its own turn, and every turn first drains the report inbox (20 rows, 16,000 chars).
 */
const HOSTS = ["mac-studio", "box-a", "box-b", null] as const;
const SUPERVISOR = ThreadId.make("thread-supervisor");

const paragraph = (lane: number, topic: string, lines: number) =>
  Array.from(
    { length: lines },
    (_, line) =>
      `- ${topic} ${line + 1} for lane ${lane}: checked the change against the plan, ran the focused suite, and noted the follow-up.`,
  ).join("\n");

type StreamEvent =
  | {
      readonly kind: "report";
      readonly lane: number;
      readonly report: "progress" | "completed";
      readonly text: string;
    }
  | { readonly kind: "wake"; readonly text: string };

export function overnightNoticeStream(lanes = 30): ReadonlyArray<StreamEvent> {
  const events: StreamEvent[] = [];
  for (let lane = 1; lane <= lanes; lane++) {
    const host = HOSTS[lane % HOSTS.length] ?? null;
    const correlationId = `corr-${lane}`;
    for (let step = 1; step <= 3; step++)
      events.push({
        kind: "report",
        lane,
        report: "progress",
        text: frameRemoteReport({
          host: host ?? "this machine",
          correlationId,
          kind: "progress",
          summary: paragraph(lane, `Milestone ${step}`, 3),
          source: "agent",
        }),
      });
    const final = `Lane ${lane} is done.\n${paragraph(lane, "Result", 18)}`;
    events.push({
      kind: "report",
      lane,
      report: "completed",
      text: frameRemoteReport({
        host: host ?? "this machine",
        correlationId,
        kind: "completed",
        summary: final,
        source: "agent",
      }),
    });
    const watch = newLaunchWatch({
      launcherThreadId: SUPERVISOR,
      host,
      threadId: ThreadId.make(`thread-lane-${lane}`),
      projectId: null,
      title: `lane-${lane}`,
      incarnation: "synthetic",
      notifyWebhook: false,
      now: 0,
    });
    events.push({
      kind: "wake",
      text: finishedWake({
        watch,
        runId: RunId.make(`run-${lane}`),
        status: "completed",
        title: `lane-${lane}`,
        branch: `feat/lane-${lane}`,
        worktreePath: `/work/lane-${lane}`,
        excerpt: final,
      }).text,
    });
    if (lane % 8 === 0)
      events.push({
        kind: "wake",
        text: pressureNudgeText({
          kind: "rise",
          host: "box-a",
          recipient: SUPERVISOR,
          pressure: {
            level: "elevated",
            since: "2026-10-23T02:00:00.000Z",
            reasons: [
              { signal: "load", level: "elevated", message: "Load per core 1.4 for 5 minutes" },
            ],
            loadPerCore: 1.4,
            eventLoopDelayMs: null,
          },
          consumers: Array.from({ length: 9 }, (_, index) => ({
            threadId: `thread-lane-${index + 1}`,
            title: `lane-${index + 1}`,
            worktreePath: `/work/lane-${index + 1}`,
            launcherThreadId: SUPERVISOR,
          })),
          alternatives: ["mac-studio", "box-b", null].map((candidate) => ({
            host: candidate,
            eligible: true,
            score: 10,
            pressure: "ok" as const,
            reasons: ["load per core 0.2", "4 lanes running"],
          })),
        }).text,
      });
  }
  return events;
}

/** Bytes of each turn's injected notice text, in order. */
export function replayNoticeStream(events: ReadonlyArray<StreamEvent>): ReadonlyArray<number> {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  let inbox: Array<{ lane: number; report: string; text: string }> = [];
  const turns: number[] = [];
  for (const event of events) {
    if (event.kind === "report") {
      // A newer progress report replaces the lane's unread one (RemoteDispatchCoordinator).
      if (event.report === "progress")
        inbox = inbox.filter((row) => !(row.lane === event.lane && row.report === "progress"));
      inbox.push({ lane: event.lane, report: event.report, text: event.text });
      continue;
    }
    const drained: string[] = [];
    let characters = 0;
    for (let head = inbox[0]; head !== undefined && drained.length < 20; head = inbox[0]) {
      const size = head.text.length + (drained.length === 0 ? 0 : 2);
      if (characters + size > 16_000) break;
      drained.push(head.text);
      inbox.shift();
      characters += size;
    }
    turns.push(
      bytes(drained.length === 0 ? event.text : `${framePendingReports(drained)}\n\n${event.text}`),
    );
  }
  return turns;
}
