import type { ComputerUsePrimitiveReply, ScreenRunError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { driverValue, fail } from "./DesktopDriverReplies.ts";
import { pollDesktopWait } from "./DesktopEvidence.ts";
import { desktopQuery, desktopRows, matchesQuery } from "./DesktopObserveRead.ts";
import { checkWindowReplyState } from "./DesktopWindows.ts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type GoneResult = { met: boolean; reason?: "incomplete_read" | "still_present" };

export const waitForGone = Effect.fn("DesktopWaitGone.waitForGone")(function* (deps: {
  readonly args: Record<string, unknown>;
  readonly pid: number;
  readonly windowId: number;
  readonly deadline: number;
  readonly read: (
    args: Record<string, unknown>,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
}) {
  const { args, pid, windowId } = deps;
  const query = desktopQuery({ role: args.role, name: args.name, text: args.value });
  if (
    args.gone !== true ||
    !query ||
    args.window !== undefined ||
    args.enabled !== undefined ||
    args.selected !== undefined
  )
    return yield* Effect.fail(fail("invalid_argument", "Use gone: true with role, name or value."));
  const result = yield* pollDesktopWait({
    read: () =>
      deps
        .read({
          pid,
          window_id: windowId,
          include_accessibility_tree: true,
          include_screenshot: false,
          max_elements: 4096,
          tree_format: "both",
        })
        .pipe(
          Effect.flatMap((reply) => {
            const checked = checkWindowReplyState(
              object(driverValue(reply)),
              pid,
              windowId,
              false,
              false,
            );
            return checked.ok ? Effect.succeed(reply) : Effect.fail(checked.error);
          }),
        ),
    initial: { met: false, reason: "incomplete_read" } as GoneResult,
    sample: (reply): GoneResult => {
      const state = object(driverValue(reply));
      const elements = Array.isArray(state?.elements) ? state.elements.map(object) : [];
      const valid =
        Array.isArray(state?.elements) &&
        elements.every((entry) => entry && typeof entry.element_token === "string");
      const rows = desktopRows(
        elements.filter((entry): entry is Record<string, unknown> => entry !== undefined),
        typeof state?.tree_markdown === "string" ? state.tree_markdown : "",
      );
      if (rows.some((row) => matchesQuery(row, query)))
        return { met: false, reason: "still_present" };
      if (
        valid &&
        state?.elements_complete === true &&
        state.truncated !== true &&
        state.filtered !== true
      )
        return { met: true };
      return { met: false, reason: "incomplete_read" };
    },
    met: (value) => value.met,
    timeoutMs: args.timeoutMs,
    cellDeadlineMillis: deps.deadline,
  });
  return {
    value: result,
    category: result.met ? ("confirmed" as const) : ("unverifiable" as const),
    evidence: [],
  };
});
