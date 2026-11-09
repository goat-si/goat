import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ComputerUsePrimitiveReply } from "@goat/contracts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, DriverError, UnknownOutcome, fixture } from "./DesktopTargetHost.testkit.ts";
import { driverError } from "./DesktopDriverReplies.ts";
import { driverOutcomeSafety, driverReplyEvidence } from "../cua/ComputerUseDriverOutcome.ts";

const replyIdentity = {
  requestId: "request",
  registrationId: "registration",
  controlId: "control",
  connectionGeneration: "generation",
  runId: "run",
  turnId: "turn",
  callId: 1,
};

it("a script write log cannot be hidden by an empty RPC log", () => {
  const reply = {
    ...replyIdentity,
    status: "unknown_outcome" as const,
    result: {
      isError: true,
      structuredContent: {
        code: "screen_locked",
        effect: "unknown",
        calls: [{ tool: "click", driver_calls: [{ tool: "click" }] }],
      },
    },
    error: { code: -32602, data: { calls: [] } },
  };
  expect(driverReplyEvidence("run_script", reply).read).toBe(false);
  expect(driverOutcomeSafety("run_script", reply).possibleCommit).toBe(true);
  expect(driverError(reply, "run_script")).toMatchObject({
    code: "screen_locked",
    effectStarted: true,
  });
});

it("a script write log without a terminal code survives an empty RPC log", () => {
  const reply = {
    status: "settled",
    result: {
      isError: true,
      structuredContent: { calls: [{ tool: "click", driver_calls: [{ tool: "click" }] }] },
    },
    error: { code: -32602, data: { calls: [] } },
  };
  expect(driverOutcomeSafety("run_script", reply).possibleCommit).toBe(true);
});

it("successful read data cannot claim a terminal refusal or a prior write", () => {
  const reply = {
    ...replyIdentity,
    status: "settled" as const,
    result: {
      isError: false,
      structuredContent: {
        code: "screen_locked",
        effect: "refused",
        safety: { possibleCommit: true },
      },
    },
  };
  expect(driverError(reply, "list_windows")).toBeUndefined();
  expect(driverOutcomeSafety("list_windows", reply)).toMatchObject({
    code: "read_completed",
    possibleCommit: false,
  });
});

it.each([undefined, "refused"])(
  "unknown outcome keeps a terminal result despite RPC rejection %#",
  (effect) => {
    const reply = {
      ...replyIdentity,
      status: "unknown_outcome" as const,
      error: { code: -32602 },
      result: {
        isError: true,
        structuredContent: { code: "screen_locked", ...(effect === undefined ? {} : { effect }) },
      },
    };
    expect(driverError(reply, "click")).toMatchObject({
      code: "screen_locked",
      effectStarted: true,
    });
    expect(driverOutcomeSafety("click", reply).possibleCommit).toBe(true);
  },
);

it("a started effect outranks a refused status on a terminal write", () => {
  const reply = {
    ...replyIdentity,
    status: "settled" as const,
    result: {
      isError: false,
      structuredContent: { code: "screen_locked", status: "refused", effect: "unknown" },
    },
  };
  expect(driverError(reply, "click")).toMatchObject({ code: "screen_locked", effectStarted: true });
  expect(driverOutcomeSafety("click", reply).possibleCommit).toBe(true);
});

it.each(["unknown", "committed", "unverifiable"])(
  "a not-started RPC lock with %s effect may have acted",
  (effect) => {
    for (const error of [
      { code: "screen_locked", effect },
      { code: "screen_locked", data: { effect } },
      { code: -32602, data: { refusal: { code: "screen_locked" }, effect } },
    ]) {
      const reply = { ...replyIdentity, status: "not_started" as const, error };
      expect(driverError(reply, "click")).toMatchObject({
        code: "screen_locked",
        effectStarted: true,
      });
      expect(driverOutcomeSafety("click", reply).possibleCommit).toBe(true);
    }
  },
);

it.each(["unknown", "committed", "unverifiable"])(
  "a settled write with %s effect keeps the person's stop",
  (effect) => {
    const reply = {
      ...replyIdentity,
      status: "settled" as const,
      result: {
        isError: false,
        structuredContent: {
          code: "screen_locked",
          refusal: { code: "stopped_by_person" },
          effect,
        },
      },
    };
    expect(driverError(reply, "click")).toMatchObject({
      code: "stopped_by_person",
      effectStarted: true,
    });
    expect(driverOutcomeSafety("click", reply).possibleCommit).toBe(true);
  },
);

it("a settled write with a lock code and no refusal may have acted", () => {
  const reply = {
    ...replyIdentity,
    status: "settled" as const,
    result: { isError: false, structuredContent: { code: "screen_locked" } },
  };
  expect(driverError(reply, "click")).toMatchObject({ code: "screen_locked", effectStarted: true });
  expect(driverOutcomeSafety("click", reply).possibleCommit).toBe(true);
});

it("terminal reply classifiers agree across the generated envelope matrix", () => {
  let count = 0;
  for (const placement of ["result", "error", "data"] as const)
    for (const code of ["screen_locked", "stopped_by_person"] as const)
      for (const nested of [false, true])
        for (const effect of [
          undefined,
          "refused",
          "unknown",
          "committed",
          "unverifiable",
        ] as const)
          for (const status of ["settled", "not_started", "unknown_outcome"] as const)
            for (const isError of [false, true])
              for (const rpc of [false, true])
                for (const tool of ["click", "list_windows"] as const)
                  for (const marked of [false, true]) {
                    const fields = {
                      ...(nested ? { refusal: { code } } : { code }),
                      ...(effect === undefined ? {} : { effect }),
                      ...(marked ? { safety: { possibleCommit: true } } : {}),
                    };
                    const reply = {
                      ...replyIdentity,
                      status,
                      result: { isError, structuredContent: placement === "result" ? fields : {} },
                      ...(placement === "error"
                        ? { error: { ...fields, ...(rpc ? { data: { code: -32602 } } : {}) } }
                        : placement === "data"
                          ? { error: { code: rpc ? -32602 : -32000, data: fields } }
                          : rpc
                            ? { error: { code: -32602 } }
                            : {}),
                    };
                    const evidence = driverReplyEvidence(tool, reply);
                    const classified = driverError(reply, tool);
                    const safety = driverOutcomeSafety(tool, reply);
                    const label = JSON.stringify({
                      placement,
                      code,
                      nested,
                      effect,
                      status,
                      isError,
                      rpc,
                      tool,
                      marked,
                    });
                    expect(classified?.effectStarted ?? false, label).toBe(safety.possibleCommit);
                    if (evidence.terminal) {
                      expect(classified?.code, label).toBe(evidence.terminal);
                      expect(safety.retryClass, label).toBe("never");
                      if (
                        tool === "click" &&
                        ((effect !== undefined && effect !== "refused") ||
                          status === "unknown_outcome")
                      )
                        expect(safety.possibleCommit, label).toBe(true);
                      if (
                        tool === "click" &&
                        (effect === undefined || effect === "refused") &&
                        evidence.refusedBeforeDispatch
                      )
                        expect(safety.possibleCommit, label).toBe(false);
                    }
                    if (tool === "list_windows" && (!marked || evidence.successfulRead))
                      expect(safety.possibleCommit, label).toBe(false);
                    count++;
                  }
  expect(count).toBe(2880);
  const logs = {
    none: undefined,
    empty: [],
    read: [{ tool: "list_windows", driver_calls: [{ tool: "list_windows" }] }],
    write: [{ tool: "click", driver_calls: [{ tool: "click" }] }],
  };
  for (const resultLog of ["none", "empty", "read", "write"] as const)
    for (const errorLog of ["none", "empty", "read", "write"] as const)
      for (const status of ["settled", "not_started", "unknown_outcome"] as const)
        for (const marked of [false, true]) {
          const reply = {
            ...replyIdentity,
            status,
            result: {
              isError: true,
              structuredContent: {
                code: "screen_locked",
                effect: "unknown",
                ...(resultLog === "none" ? {} : { calls: logs[resultLog] }),
                ...(marked ? { safety: { possibleCommit: true } } : {}),
              },
            },
            ...(errorLog === "none"
              ? {}
              : { error: { code: -32602, data: { calls: logs[errorLog] } } }),
          };
          const evidence = driverReplyEvidence("run_script", reply);
          const safety = driverOutcomeSafety("run_script", reply);
          const label = JSON.stringify({ resultLog, errorLog, status, marked });
          const expectedRead =
            status !== "unknown_outcome" &&
            (resultLog === "read" || errorLog === "read") &&
            resultLog !== "write" &&
            errorLog !== "write";
          expect(evidence.read, label).toBe(expectedRead);
          expect(driverError(reply, "run_script")?.effectStarted, label).toBe(
            safety.possibleCommit,
          );
          if (!expectedRead || marked) expect(safety.possibleCommit, label).toBe(true);
        }
});

it("a stop reason retains a screen lock's possible input effect", () => {
  expect(
    driverError({
      ...replyIdentity,
      status: "settled",
      result: {
        isError: true,
        structuredContent: {
          code: "screen_locked",
          refusal: { code: "stopped_by_person" },
          effect: "unknown",
        },
      },
    }),
  ).toMatchObject({
    code: "stopped_by_person",
    effectStarted: true,
    safety: { possibleCommit: true, retryClass: "never", code: "write_indeterminate" },
  });
});

it.live("a stopped screen-lock input reaches the host as possibly committed", () => {
  const { host, sent } = fixture({
    click: new DriverError({
      code: "screen_locked",
      refusal: { code: "stopped_by_person" },
      effect: "unknown",
    }),
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service
      .runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source:
          "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.click({x: 1, y: 2});",
      })
      .pipe(Effect.flip);
    expect(result).toMatchObject({
      code: "stopped_by_person",
      effectStarted: true,
      safety: { possibleCommit: true, retryClass: "never" },
    });
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(1);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.each([
  { isError: true, content: { code: "screen_locked", effect: "unknown" } },
  { isError: true, content: { refusal: { code: "screen_locked" }, effect: "committed" } },
  { isError: false, content: { code: "screen_locked", effect: "unverifiable" } },
  { isError: false, content: { refusal: { code: "screen_locked" }, effect: "unknown" } },
])("screen_locked with an effect that started may have acted %#", ({ isError, content }) => {
  expect(
    driverError({
      ...replyIdentity,
      status: "settled",
      result: { isError, structuredContent: content },
    }),
  ).toMatchObject({
    code: "screen_locked",
    effectStarted: true,
    safety: { code: "write_indeterminate", possibleCommit: true, retryClass: "never" },
  });
});

it.each([undefined, "refused"])("screen_locked with no effect stays unsent %#", (effect) => {
  for (const isError of effect === "refused" ? [true, false] : [true]) {
    expect(
      driverError({
        ...replyIdentity,
        status: "settled",
        result: {
          isError,
          structuredContent: { code: "screen_locked", ...(effect && { effect }) },
        },
      }),
    ).toMatchObject({ code: "screen_locked", effectStarted: false });
  }
});

it.each([undefined, "refused"])(
  "screen_locked preserves possible commit despite absent or refused effect %#",
  (effect) => {
    for (const extra of [
      { status: "unknown_outcome" as const },
      { safety: { possibleCommit: true } },
    ]) {
      expect(
        driverError({
          ...replyIdentity,
          status: extra.status ?? "settled",
          result: {
            isError: true,
            structuredContent: {
              code: "screen_locked",
              ...(effect && { effect }),
              ...(extra.safety && { safety: extra.safety }),
            },
          },
        }),
      ).toMatchObject({ code: "screen_locked", effectStarted: true });
    }
  },
);

// Stop and lock end the cell even when its script catches the individual tool error.
it.live.each([
  { code: "stopped_by_person", method: "click", tool: "click" },
  { code: "stopped_by_person", method: "observe", tool: "get_window_state" },
  { code: "screen_locked", method: "click", tool: "click" },
  { code: "screen_locked", method: "observe", tool: "get_window_state" },
])("screen.run preserves interrupted $code for $method", ({ code, method, tool }) => {
  const { host } = fixture({
    [tool]: new UnknownOutcome(
      { code, ...(method === "click" ? { effect: "unverifiable" } : {}) },
      "The person stopped this action.",
    ),
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service
      .runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); try { await app.${method}(${method === "click" ? "{x: 1, y: 2}" : ""}); } catch (e) { return { code: e.code, nextStep: e.nextStep, retryClass: e.safety?.retryClass, possibleCommit: e.safety?.possibleCommit }; }`,
      })
      .pipe(Effect.flip);
    expect(result).toMatchObject({
      code,
      safety: { retryClass: "never", possibleCommit: method === "click" },
    });
    expect(result.nextStep).toMatch(code === "screen_locked" ? /unlock/i : /stop/i);
    expect(result.nextStep).not.toMatch(/try again/i);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live.each([
  { code: "user_interacting", method: "click", tool: "click" },
  { code: "user_interacting", method: "observe", tool: "get_window_state" },
  { code: "screen_locked", method: "click", tool: "click" },
  { code: "screen_locked", method: "observe", tool: "get_window_state" },
])("$code stops desktop $method with a typed error", ({ code, method, tool }) => {
  const { host, sent } = fixture({
    [tool]: new DriverError({ effect: "refused", refusal: { code, retry_after_ms: 750 } }),
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const outcome = yield* service
      .runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
        try { await app.${method}(${method === "click" ? "{x: 1, y: 2}" : ""}); return 'success'; }
        catch (e) { return { name: e.name, code: e.code, nothingSent: e.nothingSent, effectStarted: e.effectStarted, refused: e.refused, nextStep: e.nextStep, retryClass: e.safety?.retryClass }; }`,
      })
      .pipe(Effect.result);
    if (code === "screen_locked") {
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure).toMatchObject({
          code,
          effectStarted: false,
          nextStep: expect.stringMatching(/unlock/i),
          safety: { retryClass: "never", possibleCommit: false },
        });
    } else {
      expect(outcome._tag).toBe("Success");
      if (outcome._tag === "Success")
        expect(outcome.success.value).toMatchObject({
          name: "ScreenError",
          code,
          nothingSent: true,
          effectStarted: false,
          refused: "targetRefused",
          nextStep: expect.stringMatching(/750.*observe/i),
        });
    }
    expect(sent.filter((entry) => entry.tool === tool)).toHaveLength(1);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live.each(["user_interacting", "screen_locked"])(
  "%s in a verification read stops the input before it is sent",
  (code) => {
    let listings = 0;
    const { host, sent } = fixture({
      list_windows: () =>
        ++listings === 1
          ? { windows: [{ pid: 42, window_id: 7, title: "Document" }] }
          : new DriverError({ code, retry_after_ms: 750 }),
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const outcome = yield* service
        .runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation: context.invocation,
          source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
          try { await app.click({x: 1, y: 2, verify: true}); return 'success'; }
          catch (e) { return { code: e.code, nothingSent: e.nothingSent, retryClass: e.safety?.retryClass }; }`,
        })
        .pipe(Effect.result);
      if (code === "screen_locked") {
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure")
          expect(outcome.failure).toMatchObject({
            code,
            effectStarted: false,
            safety: { retryClass: "never", possibleCommit: false },
          });
      } else {
        expect(outcome._tag).toBe("Success");
        if (outcome._tag === "Success")
          expect(outcome.success.value).toEqual({
            code,
            nothingSent: true,
            retryClass: "new_key",
          });
      }
      expect(sent.some((entry) => entry.tool === "click")).toBe(false);
      yield* service.finishTurn({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

it.live.each(["user_interacting", "screen_locked"])(
  "%s after an input reports that the input may have landed",
  (code) => {
    let listings = 0;
    const { host, sent } = fixture({
      list_windows: () =>
        ++listings <= 2
          ? { windows: [{ pid: 42, window_id: 7, title: "Document" }] }
          : new DriverError({ code, retry_after_ms: 750 }),
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const outcome = yield* service
        .runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation: context.invocation,
          source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
          try { await app.click({x: 1, y: 2, verify: true}); return 'success'; }
          catch (e) { return { code: e.code, nothingSent: e.nothingSent, possibleCommit: e.safety?.possibleCommit }; }`,
        })
        .pipe(Effect.result);
      if (code === "screen_locked") {
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure")
          expect(outcome.failure).toMatchObject({
            code,
            effectStarted: true,
            safety: { retryClass: "never", possibleCommit: true },
          });
      } else {
        expect(outcome._tag).toBe("Success");
        if (outcome._tag === "Success")
          expect(outcome.success.value).toEqual({ code, nothingSent: false, possibleCommit: true });
      }
      expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(1);
      yield* service.finishTurn({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

it.live.each([
  { label: "observe", expression: "app.observe()" },
  { label: "query", expression: "app.observe({query: {name: 'Apply'}})" },
])("a locked accessibility tree fails $label without retrying", ({ expression }) => {
  const { host, sent } = fixture({
    get_window_state: {
      pid: 42,
      window_id: 7,
      tree_markdown: "",
      elements: [],
      degraded: true,
      degraded_reason:
        "screen_locked: window_id 7 has no accessibility tree because the screen is locked.",
      escalation: { recommended: "wait_for_unlock", reason: "Unlock the screen." },
    },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service
      .runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
        try { await ${expression}; return 'success'; }
        catch (e) { return {name: e.name, code: e.code, nothingSent: e.nothingSent, effectStarted: e.effectStarted, retryClass: e.safety?.retryClass}; }`,
      })
      .pipe(Effect.flip);
    expect(result).toMatchObject({
      code: "screen_locked",
      effectStarted: false,
      safety: { retryClass: "never", possibleCommit: false },
    });
    expect(sent.filter((entry) => entry.tool === "get_window_state")).toHaveLength(1);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live("a screenshot-only read succeeds while the screen is locked", () => {
  const { host, sent } = fixture({
    get_window_state: {
      pid: 42,
      window_id: 7,
      tree_markdown: "",
      elements: [],
      degraded: true,
      degraded_reason:
        "screen_locked: window_id 7 has no accessibility tree because the screen is locked.",
      escalation: { recommended: "wait_for_unlock" },
      screenshot_width: 100,
      screenshot_height: 80,
      image: {
        mimeType: "image/png",
        bytes: Buffer.from("png").toString("base64"),
        width: 100,
        height: 80,
      },
    },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source:
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.screenshot(); return 'captured';",
    });
    expect(result.value).toBe("captured");
    expect(sent.filter((entry) => entry.tool === "get_window_state")).toHaveLength(1);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

const launchArgs = { bundle_id: "com.apple.calculator" };
const outsideManifest =
  "launch_app bundle_id 'com.apple.calculator' is outside the capability manifest";
const notGranted = "Accessibility access is not granted.";
const notApproved = "com.apple.calculator is not approved for computer use in this thread.";
const manifestNote =
  "GOAT: this is outside what GOAT lets agents do with computer use on this host, not a missing macOS permission.";
const genericNextStep = "Observe the desktop and try again.";
const failedCall = (
  structuredContent: NonNullable<ComputerUsePrimitiveReply["result"]>,
  ...texts: ReadonlyArray<string>
) => ({
  ...replyIdentity,
  status: "settled" as const,
  result: {
    isError: true,
    structuredContent,
    ...(texts.length === 0 ? {} : { content: texts.map((text) => ({ type: "text", text })) }),
  },
});

it.each([
  {
    shape: "an outer code with text",
    reply: failedCall({ code: "permission_denied" }, notGranted),
    nextStep: notGranted,
  },
  {
    shape: "a nested refusal message",
    reply: failedCall({ refusal: { code: "permission_denied", message: notGranted } }),
    nextStep: notGranted,
  },
  {
    shape: "no words",
    reply: failedCall({ code: "permission_denied" }),
    nextStep: "The driver refused permission; read the receipt and request the required admission.",
  },
])(
  "a driver permission refusal with no effect stays permission_denied and unsent: $shape",
  ({ reply, nextStep }) => {
    expect(driverError(reply, "launch_app", launchArgs)).toEqual({
      code: "permission_denied",
      effectStarted: false,
      nextStep,
      evidence: ["driver:code=permission_denied"],
    });
  },
);

it("a driver permission refusal keeps the refusal fields it was given", () => {
  const fields = {
    refused: "appNotAllowed",
    detail: "app_not_approved",
    app: "com.apple.calculator",
  };
  expect(
    driverError(
      failedCall({ code: "permission_denied", ...fields }, notApproved),
      "launch_app",
      launchArgs,
    ),
  ).toEqual({
    code: "permission_denied",
    effectStarted: false,
    nextStep: notApproved,
    evidence: ["driver:code=permission_denied"],
    ...fields,
  });
});

it("a manifest denial typed outside_manifest stays unsupported with the driver's words, never a permission to ask for", () => {
  const fields = { refused: "targetRefused", detail: "outside_manifest" };
  expect(
    driverError(
      failedCall({ code: "permission_denied", ...fields }, outsideManifest, manifestNote),
      "launch_app",
      launchArgs,
    ),
  ).toEqual({
    code: "unsupported",
    effectStarted: false,
    nextStep: outsideManifest,
    evidence: ["driver:code=permission_denied"],
    ...fields,
  });
});

const launchFailed = "Launch failed: The application “Calculator” could not be launched.";

it.each([
  {
    shape: "a launch error named under error",
    structured: { error: "NSWORKSPACE_LAUNCH_FAILED" },
    texts: [launchFailed],
    expected: { nextStep: launchFailed },
  },
  {
    shape: "an unknown code",
    structured: { code: "app_launch_blocked" },
    texts: ["Launch blocked by policy."],
    expected: {
      nextStep: "Launch blocked by policy.",
      evidence: ["driver:code=app_launch_blocked"],
    },
  },
  {
    shape: "permission_denied with an unknown effect",
    structured: { code: "permission_denied", effect: "unknown" },
    texts: [outsideManifest],
    expected: {
      nextStep: outsideManifest,
      evidence: ["driver:effect=unknown", "driver:code=permission_denied"],
    },
  },
  {
    shape: "permission_denied that may have run",
    structured: { code: "permission_denied", safety: { possibleCommit: true } },
    texts: [outsideManifest],
    expected: { nextStep: outsideManifest, evidence: ["driver:code=permission_denied"] },
  },
  {
    shape: "a manifest denial that may have run",
    structured: {
      code: "permission_denied",
      refused: "targetRefused",
      detail: "outside_manifest",
      safety: { possibleCommit: true },
    },
    texts: [outsideManifest],
    expected: {
      nextStep: outsideManifest,
      evidence: ["driver:code=permission_denied"],
      refused: "targetRefused",
      detail: "outside_manifest",
    },
  },
])(
  "a failed driver call with any other code stays downstream_failure and keeps the driver's words: $shape",
  ({ structured, texts, expected }) => {
    expect(driverError(failedCall(structured, ...texts), "launch_app", launchArgs)).toEqual({
      code: "downstream_failure",
      effectStarted: false,
      ...expected,
    });
  },
);

it("an unverifiable driver failure stays unknown_outcome and may have acted", () => {
  expect(
    driverError(
      failedCall({ code: "permission_denied", effect: "unverifiable" }, outsideManifest),
      "launch_app",
      launchArgs,
    ),
  ).toMatchObject({ code: "unknown_outcome", effectStarted: true, nextStep: genericNextStep });
});

it("a failed driver call with no code or words keeps the generic next step", () => {
  for (const reply of [
    failedCall({}),
    { ...replyIdentity, status: "settled" as const, error: { code: -32603 } },
  ])
    expect(driverError(reply, "launch_app", launchArgs)).toEqual({
      code: "downstream_failure",
      effectStarted: false,
      nextStep: genericNextStep,
    });
});

it.live(
  "screen.launch reports a manifest refusal as unsupported with the driver's words and nothing sent",
  () => {
    const { host, sent } = fixture({
      launch_app: new DriverError(
        { code: "permission_denied", refused: "targetRefused", detail: "outside_manifest" },
        outsideManifest,
      ),
    });
    return Effect.gen(function* () {
      const result = yield* (yield* ScreenRunService).runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `try { await screen.launch({bundle_id: 'com.apple.calculator'}); return 'launched'; }
        catch (e) { return { code: e.code, nothingSent: e.nothingSent, message: e.message, refused: e.refused, detail: e.detail, evidence: e.evidence }; }`,
      });
      expect(result.value).toEqual({
        code: "unsupported",
        nothingSent: true,
        message: outsideManifest,
        refused: "targetRefused",
        detail: "outside_manifest",
        evidence: ["driver:code=permission_denied"],
      });
      expect(sent.map((entry) => entry.tool)).toEqual(["launch_app"]);
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);
