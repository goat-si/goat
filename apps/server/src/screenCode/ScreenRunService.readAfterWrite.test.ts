import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { EnvironmentId, ProviderInstanceId, ScreenRunError, ThreadId } from "@goat/contracts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { screenActionSafety } from "./ScreenActionOutcome.ts";

const invocation = {
  environmentId: "env" as EnvironmentId,
  capabilities: new Set(["preview" as const]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: "thread" as ThreadId,
    providerSessionId: "s",
    providerInstanceId: "p" as ProviderInstanceId,
  },
  reauthorize: () => Effect.void,
};
const targetRef = {
  id: "target",
  kind: "tab" as const,
  environmentId: "env",
  runId: "run",
  turnId: "turn",
  generation: 0,
};
// The lease proxy's words for a read it refused after foreground approval ended under it.
const READ_REFUSED =
  "Foreground approval reached its time limit, so this work was stopped. Observe again before acting. Nothing was sent.";

/** Runs one cell whose press goes out as `press` says and whose next read is refused. */
const cellAfterPress = (press: "confirmed" | "unverifiable" | "none") =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    return yield* service
      .runCell({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        invocation,
        source:
          press === "none"
            ? "const tab = await screen.tab({tabId: 'tab'}); await tab.observe(); return true;"
            : "const tab = await screen.tab({tabId: 'tab'}); await tab.press('Enter'); await tab.observe(); return true;",
      })
      .pipe(Effect.flip);
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
        dispatcher: {
          availability: () => Effect.succeed([{ kind: "tab", available: true }]),
          dispatch: (call) =>
            call.method === "select_tab"
              ? Effect.succeed({
                  value: {
                    targetRef,
                    tab: { tabId: "tab", title: "Chat", url: "https://chat.test/" },
                  },
                  category: "confirmed" as const,
                })
              : call.method === "press_key"
                ? Effect.succeed(
                    press === "confirmed"
                      ? {
                          value: { effect: "confirmed" },
                          category: "confirmed" as const,
                          evidence: ["driver:effect=confirmed"],
                        }
                      : { value: {}, category: "unverifiable" as const },
                  )
                : Effect.fail<ScreenRunError>({
                    code: "unavailable",
                    effectStarted: false,
                    nextStep: READ_REFUSED,
                    refused: "targetRefused",
                    detail: "foreground_not_approved",
                    safety: screenActionSafety(call, "refused", false),
                  }),
        },
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );

const receiptOf = (error: { readonly receipts?: ScreenRunError["receipts"] }, method: string) =>
  error.receipts?.find((receipt) => receipt.method === method);

it.live(
  "a read refused after a confirmed press keeps the press as sent and never says nothing was sent",
  () =>
    Effect.gen(function* () {
      const error = yield* cellAfterPress("confirmed");
      // The cell as a whole may have committed, so it is never rerun.
      expect(error.safety).toMatchObject({ possibleCommit: true, retryClass: "never" });
      expect(receiptOf(error, "press_key")?.safety?.code).toBe("write_committed");
      // The refused read stays the read's own failure on its receipt.
      expect(receiptOf(error, "observe")).toMatchObject({
        category: "refused",
        dispatched: false,
        refused: "targetRefused",
        detail: "foreground_not_approved",
        safety: { code: "read_failed_pre_dispatch" },
      });
      expect(error.nextStep).not.toMatch(/nothing was sent/i);
      expect(error.nextStep).toMatch(/press_key/);
      expect(error.nextStep).toMatch(/was confirmed/);
      expect(error.nextStep).toMatch(/new cell/);
      expect(error.nextStep).toMatch(/Foreground approval reached its time limit/);
    }),
);

it.live("a read refused after a press whose effect is unknown says it may have taken effect", () =>
  Effect.gen(function* () {
    const error = yield* cellAfterPress("unverifiable");
    expect(error.safety).toMatchObject({ possibleCommit: true, retryClass: "never" });
    expect(error.nextStep).not.toMatch(/nothing was sent/i);
    expect(error.nextStep).not.toMatch(/was confirmed/);
    expect(error.nextStep).toMatch(/may have taken effect/);
  }),
);

it.live("a read refused before any input in its cell still says nothing was sent", () =>
  Effect.gen(function* () {
    const error = yield* cellAfterPress("none");
    expect(error.safety).toMatchObject({ possibleCommit: false, code: "read_failed_pre_dispatch" });
    expect(error.nextStep).toBe(READ_REFUSED);
  }),
);
