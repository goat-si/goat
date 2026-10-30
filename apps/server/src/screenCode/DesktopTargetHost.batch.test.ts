import { expect, it } from "@effect/vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { ComputerUsePrimitiveRequest } from "@goat/contracts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

const cellService = (host: ReturnType<typeof fixture>["host"]) =>
  ScreenRunService.layerWithRuntime({
    dispatcher: createScreenDispatchRouter({ app: host }),
    invocation: {
      command: process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
  }).pipe(Layer.provide(NodeServices.layer));

const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
const runCell = (source: string) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    return yield* service.runCell({ ...turn, invocation: context.invocation, source });
  });
const finish = Effect.gen(function* () {
  const service = yield* ScreenRunService;
  yield* service.finishTurn({ ...turn, reason: "test" });
});

const BIND =
  "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe();";
/** Each settled click as its verdict, or its error code and whether nothing was sent. */
const SETTLED =
  "return (await Promise.allSettled(clicks)).map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent);";
const clicks = (count: number) =>
  `const clicks = Array.from({ length: ${count} }, () => app.click('Apply'));`;
// Until the driver bounds each run_steps step by its own deadline, a group's element input goes
// one call at a time, so one call that never answers costs only its own cap.
it.live("eight unawaited element clicks on one window reach the driver one at a time", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    const result = yield* runCell(`${BIND} ${clicks(8)} ${SETTLED}`);
    expect(result.value).toEqual(Array.from({ length: 8 }, () => "confirmed"));
    expect(sent.map((entry) => entry.tool)).toEqual([
      "list_apps",
      "list_windows",
      "get_window_state",
      ...Array.from({ length: 8 }, () => "click"),
    ]);
    expect(result.journal.filter((entry) => entry.receipt.method === "click")).toHaveLength(8);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "element typing started together past the primitive args cap goes one call at a time",
  () => {
    const { host, sent } = fixture();
    // What the lease stream encodes for each call; it rejects args over the primitive cap.
    const primitive = Schema.decodeUnknownSync(ComputerUsePrimitiveRequest);
    return Effect.gen(function* () {
      // Each typing is within the cell's own limit; together they are past the channel's.
      const result = yield* runCell(
        `${BIND} const clicks = [app.type('x'.repeat(33000), 'Apply'), app.type('y'.repeat(33000), 'Apply')]; ${SETTLED}`,
      );
      expect(result.value).toEqual(["confirmed", "confirmed"]);
      expect(sent.map((entry) => entry.tool).slice(3)).toEqual(["type_text", "type_text"]);
      for (const [callId, entry] of sent.entries())
        expect(() =>
          primitive({
            state: "primitive-request",
            requestId: "request",
            registrationId: "registration",
            controlId: "control",
            connectionGeneration: "driver:1",
            runId: "r",
            turnId: "t",
            callId,
            deadlineMillis: 1000,
            tool: entry.tool,
            args: entry.args,
          }),
        ).not.toThrow();
      yield* finish;
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live("a refused click stops the group, and the cell sees which clicks ran", () => {
  let clicked = 0;
  const { host, sent } = fixture({
    click: () =>
      ++clicked === 1
        ? { effect: "confirmed", evidence: ["driver:acted"] }
        : new DriverError({
            effect: "refused",
            code: "outside_scope",
            message: "click: refused by the scope",
          }),
  });
  return Effect.gen(function* () {
    const result = yield* runCell(
      `${BIND} ${clicks(3)} const settled = await Promise.allSettled(clicks); return settled.map((r) => r.status === 'fulfilled' ? r.value.verdict : [r.reason.code, r.reason.nothingSent]);`,
    );
    expect(result.value).toEqual(["confirmed", ["permission_denied", true], ["not_run", true]]);
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(2);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "a group the runtime cannot take whole is refused whole, without waiting for its deadline",
  () => {
    const { host, sent } = fixture();
    return Effect.gen(function* () {
      // The second typing is past the runtime's argument limit, so none of the group goes out.
      const result = yield* runCell(
        `${BIND} const clicks = [app.type('a', 'Apply'), app.type('x'.repeat(66000), 'Apply')]; ${SETTLED}`,
      );
      expect(result.status).toBe("completed");
      expect(result.value).toEqual(["refused:true", "refused:true"]);
      expect(sent.map((entry) => entry.tool)).toEqual([
        "list_apps",
        "list_windows",
        "get_window_state",
      ]);
      yield* finish;
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live("a batch group takes one pending place, so a run longer than one group still runs", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    // Seventeen is one group of sixteen and one more click, under a limit of four pending calls.
    const result = yield* runCell(`${BIND} ${clicks(17)} ${SETTLED}`);
    expect(result.value).toEqual(Array.from({ length: 17 }, () => "confirmed"));
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(17);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("a refused group sends nothing and, like any refusal, leaves the cell free", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    // Sixteen calls make one group, refused whole for its oversized typing; the seventeenth goes
    // alone, and so does a call the cell makes after it caught the refusal.
    const result = yield* runCell(
      `${BIND} const clicks = [app.type('x'.repeat(66000), 'Apply'), ...Array.from({ length: 16 }, () => app.click('Apply'))];
      const settled = (await Promise.allSettled(clicks)).map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent);
      const after = (await app.click('Apply')).verdict;
      return { settled, after };`,
    );
    expect(result.value).toEqual({
      settled: [...Array.from({ length: 16 }, () => "refused:true"), "confirmed"],
      after: "confirmed",
    });
    expect(sent.map((entry) => entry.tool).filter((tool) => tool === "click")).toEqual([
      "click",
      "click",
    ]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "T61a/T61b/T61c: concurrent desktop point clicks queue in one batch group and run one at a time, while out-of-bounds points fail batch preflight before any click is sent",
  () => {
    const framedWindow = {
      pid: 42,
      window_id: 7,
      snapshot_id: "s0000000a",
      elements_complete: false,
      tree_format: "both",
      tree_markdown: ['- [0] AXWindow "Editor"', '  - [1] AXButton "Apply" [actions=[press]]'].join(
        "\n",
      ),
      elements: [
        {
          element_index: 0,
          element_token: "s0000000a:0",
          role: "AXWindow",
          label: "Editor",
          frame: { x: 100, y: 200, w: 674, h: 408 },
        },
        {
          element_index: 1,
          element_token: "s0000000a:1",
          role: "AXButton",
          label: "Apply",
          parent_index: 0,
          frame: { x: 140, y: 260, w: 80, h: 30 },
          actions: ["AXPress"],
        },
      ],
      window_bounds: { x: 100, y: 200, width: 674, height: 408 },
      screenshot_width: 1348,
      screenshot_height: 816,
      screenshot_scale: 2,
      image: {
        mimeType: "image/png" as const,
        bytes: Buffer.from("png").toString("base64"),
        width: 1348,
        height: 816,
      },
    };
    return Effect.gen(function* () {
      const { host, sent } = fixture({ get_window_state: framedWindow });
      yield* Effect.gen(function* () {
        // T61a: 6 concurrent {window:[x,y]} clicks and 6 concurrent [x,y] pixel clicks all succeed in order.
        const sixWin = yield* runCell(
          `${BIND} const pts = [[502,157],[502,157],[436,211],[634,319],[502,211],[634,373]];
          const clicks = pts.map((p) => app.click({ window: p })); ${SETTLED}`,
        );
        expect(sixWin.value).toEqual(Array.from({ length: 6 }, () => "confirmed"));
        expect(sent.filter((s) => s.tool === "click")).toHaveLength(6);

        const sixPx = yield* runCell(
          `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
          await app.screenshot();
          const pxs = [[100,100],[200,100],[300,100],[400,100],[500,100],[600,100]];
          const clicks = pxs.map((p) => app.click(p)); ${SETTLED}`,
        );
        expect(sixPx.value).toEqual(Array.from({ length: 6 }, () => "confirmed"));
        expect(sent.filter((s) => s.tool === "click")).toHaveLength(12);

        // T61c: out-of-bounds 2nd window point or pixel point in Promise.all aborts preflight before step 0 is sent.
        const beforeOob = sent.filter((s) => s.tool === "click").length;
        const oobBatch = yield* runCell(
          `${BIND} await app.screenshot();
          const winSettled = (await Promise.allSettled([app.click({ window: [10, 10] }), app.click({ window: [900, 900] })])).map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent);
          const pxSettled = (await Promise.allSettled([app.click([10, 10]), app.click([5000, 5000])])).map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent);
          return { winSettled, pxSettled };`,
        );
        expect(oobBatch.value).toEqual({
          winSettled: ["not_run:true", "invalid_argument:true"],
          pxSettled: ["not_run:true", "invalid_argument:true"],
        });
        expect(sent.filter((s) => s.tool === "click")).toHaveLength(beforeOob);
        yield* finish;
      }).pipe(Effect.provide(cellService(host)));

      // T61b: Deferred blocking the 1st {window:[10,10]} click proves the 2nd click does not reach the driver until the 1st completes.
      const firstClickReached = yield* Deferred.make<void>();
      const releaseFirstClick = yield* Deferred.make<void>();
      let clickCalls = 0;
      const base = fixture({ get_window_state: framedWindow });
      const gatedHost = createDesktopTargetHost({
        primitiveChannel: {
          request: (req: { tool: string }) =>
            req.tool === "click" && ++clickCalls === 1
              ? Deferred.succeed(firstClickReached, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirstClick)),
                  Effect.andThen(base.channel.request(req as never)),
                )
              : base.channel.request(req as never),
        } as never,
        leases: base.leases,
        platform: "darwin",
      });
      yield* Effect.gen(function* () {
        const fiber = yield* runCell(
          `${BIND} const clicks = [app.click({ window: [10, 10] }), app.click({ window: [20, 20] })]; ${SETTLED}`,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(firstClickReached);
        // While the 1st click is blocked on releaseFirstClick, the 2nd click has NOT been sent to the driver.
        expect(clickCalls).toBe(1);
        expect(base.sent.filter((s) => s.tool === "click")).toHaveLength(0);
        yield* Deferred.succeed(releaseFirstClick, undefined);
        const done = yield* Fiber.join(fiber);
        expect(done.value).toEqual(["confirmed", "confirmed"]);
        expect(base.sent.filter((s) => s.tool === "click")).toHaveLength(2);
        yield* finish;
      }).pipe(Effect.provide(cellService(gatedHost)));
    });
  },
);

it.live(
  "a batched click that asks to verify reads the windows around itself, and one that does not reads none",
  () => {
    const { host, sent } = fixture({ click: { effect: "unverifiable" } });
    return Effect.gen(function* () {
      yield* runCell(
        `${BIND} await Promise.all([app.click('Apply'), app.click('Apply', {verify: true})]);`,
      );
      expect(sent.map((entry) => entry.tool).slice(3)).toEqual([
        "click",
        "list_windows",
        "click",
        "list_windows",
      ]);
      yield* finish;
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live("concurrent app press, scroll and click are admitted as one ordered group", () => {
  const { host, sent } = fixture({
    list_windows: {
      windows: [
        {
          pid: 42,
          window_id: 7,
          title: "Document",
          bounds: { x: 10, y: 20, width: 100, height: 100 },
        },
      ],
    },
  });
  return Effect.gen(function* () {
    const result = yield* runCell(
      `${BIND} const clicks = [app.press('a'), app.scroll(null, 'down'), app.click('Apply')]; ${SETTLED}`,
    );
    expect(result.value).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(
      sent
        .filter((entry) => ["press_key", "scroll", "click"].includes(entry.tool))
        .map((entry) => entry.tool),
    ).toEqual(["press_key", "scroll", "click"]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "a guarded press refuses its whole concurrent group without sending the earlier click",
  () => {
    const { host, sent } = fixture({
      list_apps: { apps: [{ pid: 42, name: "KakaoTalk", bundle_id: "com.kakao.KakaoTalkMac" }] },
    });
    return Effect.gen(function* () {
      const result = yield* runCell(
        `const app = await screen.app({bundle_id: 'com.kakao.KakaoTalkMac', window_id: 7}); await app.observe(); const clicks = [app.click('Apply'), app.press('Enter', 'Apply')]; ${SETTLED}`,
      );
      expect(result.value).toEqual(["not_run:true", "permission_denied:true"]);
      expect(sent.filter((entry) => ["press_key", "click"].includes(entry.tool))).toEqual([]);
      yield* finish;
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live("a user interacting refusal stops subsequent concurrent app inputs", () => {
  const { host, sent } = fixture({
    press_key: new DriverError({
      effect: "refused",
      refusal: { code: "user_interacting", retry_after_ms: 750 },
    }),
  });
  return Effect.gen(function* () {
    const result = yield* runCell(
      `${BIND} const clicks = [app.click('Apply'), app.press('a'), app.click('Apply')]; ${SETTLED}`,
    );
    expect(result.value).toEqual(["confirmed", "user_interacting:true", "not_run:true"]);
    expect(
      sent
        .filter((entry) => ["press_key", "click"].includes(entry.tool))
        .map((entry) => entry.tool),
    ).toEqual(["click", "press_key"]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("a failed middle input leaves later group members not run", () => {
  const { host, sent } = fixture({
    press_key: new DriverError({ effect: "refused", code: "outside_scope" }),
  });
  return Effect.gen(function* () {
    const result = yield* runCell(
      `${BIND} const clicks = [app.click('Apply'), app.press('a'), app.click('Apply')]; ${SETTLED}`,
    );
    expect(result.value).toEqual(["confirmed", "permission_denied:true", "not_run:true"]);
    expect(
      sent
        .filter((entry) => ["press_key", "click"].includes(entry.tool))
        .map((entry) => entry.tool),
    ).toEqual(["click", "press_key"]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("adjacent groups for separate windows keep each window's inputs together", () => {
  const { host, sent } = fixture({
    list_windows: {
      windows: [
        { pid: 42, window_id: 7, title: "First" },
        { pid: 42, window_id: 8, title: "Second" },
      ],
    },
  });
  return Effect.gen(function* () {
    const result =
      yield* runCell(`const a = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
      const b = await screen.app({bundle_id: 'org.example.Editor', window_id: 8});
      const clicks = [a.press('a'), a.press('b'), b.press('c'), b.press('d')]; ${SETTLED}`);
    expect(result.value).toEqual(["confirmed", "confirmed", "confirmed", "confirmed"]);
    expect(
      sent
        .filter((entry) => entry.tool === "press_key")
        .map((entry) => (entry.args as { key: string }).key),
    ).toEqual(["a", "b", "c", "d"]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("an invalid selection and a guarded menu refuse their whole groups", () => {
  const { host, sent } = fixture({
    list_apps: { apps: [{ pid: 42, name: "KakaoTalk", bundle_id: "com.kakao.KakaoTalkMac" }] },
  });
  return Effect.gen(function* () {
    const result =
      yield* runCell(`const app = await screen.app({bundle_id:'com.kakao.KakaoTalkMac', window_id:7}); await app.observe();
      const select = await Promise.allSettled([app.click('Apply'), app.selectText('Apply', '')]);
      const menu = await Promise.allSettled([app.click('Apply'), app.menu(['Chat', 'Send'])]);
      return [select, menu].map((group) => group.map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent));`);
    expect(result.value).toEqual([
      ["not_run:true", "invalid_argument:true"],
      ["not_run:true", "permission_denied:true"],
    ]);
    expect(
      sent.filter((entry) => ["click", "select_text", "invoke_menu"].includes(entry.tool)),
    ).toEqual([]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("app group inputs use the pinned driver schemas", () => {
  // Driver tag goat.16: platform-macos/tools/{press_key.rs:521,scroll.rs:79,click.rs:1090};
  // cua-driver-core/post_action_wait.rs:28-42 adds post_action_wait at dispatch.
  const properties: Record<string, JsonSchemaType> = {
    session: { type: "string" },
    pid: { type: "integer" },
    window_id: { type: "integer" },
    key: { type: "string" },
    modifiers: { type: "array", items: { type: "string" } },
    element_token: { type: "string", pattern: "^s[0-9a-f]{8}:[0-9]+$" },
    x: { type: "number" },
    y: { type: "number" },
    scope: { type: "string", enum: ["window", "desktop"] },
    delivery_mode: { type: "string", enum: ["background", "foreground"] },
    target: {
      type: "object",
      properties: {
        kind: { enum: ["window", "desktop"] },
        pid: { type: "integer", minimum: 0 },
        window_id: { type: "integer", minimum: 0 },
        display_id: { type: "string" },
      },
      required: ["kind"],
      additionalProperties: true,
    },
    post_action_wait: { type: "string", enum: ["default", "none"] },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    by: { type: "string", enum: ["line", "page"] },
    amount: { type: "integer", minimum: 1, maximum: 50 },
    coordinate_space: { type: "string", enum: ["screenshot", "window_points"] },
    window_basis: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
      },
      required: ["x", "y", "w", "h"],
      additionalProperties: false,
    },
    capture_id: { type: "string" },
    action: { type: "string" },
    button: { type: "string", enum: ["left", "right", "middle"] },
    count: { type: "integer" },
    read_back: { type: "boolean" },
    modifier: { type: "array", items: { type: "string" } },
    from_zoom: { type: "boolean" },
    debug_image_out: { type: "string" },
  };
  const common = [
    "session",
    "pid",
    "window_id",
    "element_token",
    "x",
    "y",
    "scope",
    "delivery_mode",
    "target",
    "post_action_wait",
  ];
  const pointer = ["coordinate_space", "window_basis"];
  const specs = {
    press_key: { keys: [...common, "key", "modifiers"], required: ["key"] },
    scroll: { keys: [...common, ...pointer, "direction", "by", "amount"], required: ["direction"] },
    click: {
      keys: [
        ...common,
        ...pointer,
        "capture_id",
        "action",
        "button",
        "count",
        "read_back",
        "modifier",
        "from_zoom",
        "debug_image_out",
      ],
      required: [],
    },
  };
  const validator = new AjvJsonSchemaValidator();
  const checked = (tool: keyof typeof specs) => {
    const spec = specs[tool];
    const check = validator.getValidator({
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(spec.keys.map((key) => [key, properties[key]])),
      required: spec.required,
    });
    return (args: Record<string, unknown>) => {
      const result = check(args);
      if (result.valid) return { effect: "confirmed" };
      return new DriverError({ effect: "refused", code: "invalid_arguments" }, result.errorMessage);
    };
  };
  const { host } = fixture({
    list_windows: {
      windows: [
        {
          pid: 42,
          window_id: 7,
          title: "Document",
          bounds: { x: 10, y: 20, width: 100, height: 100 },
        },
      ],
    },
    get_window_state: {
      pid: 42,
      window_id: 7,
      snapshot_id: "s0000000a",
      tree_markdown: "Apply",
      elements_complete: true,
      elements: [{ role: "button", label: "Apply", element_token: "s0000000a:1" }],
    },
    press_key: checked("press_key"),
    scroll: checked("scroll"),
    click: checked("click"),
  });
  return Effect.gen(function* () {
    const result = yield* runCell(
      `${BIND} const clicks = [app.press('a'), app.scroll(null, 'down'), app.click('Apply')]; ${SETTLED}`,
    );
    expect(result.value).toEqual(["confirmed", "confirmed", "confirmed"]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("a refused drag prevents its concurrent group from sending", () => {
  const { host, sent } = fixture({
    list_apps: { apps: [{ pid: 42, name: "KakaoTalk", bundle_id: "com.kakao.KakaoTalkMac" }] },
  });
  return Effect.gen(function* () {
    const result =
      yield* runCell(`const app = await screen.app({bundle_id:'com.kakao.KakaoTalkMac', window_id:7}); await app.observe();
      const clicks = [app.click('Apply'), app.drag('Apply', 'Apply')]; ${SETTLED}`);
    expect(result.value).toEqual(["not_run:true", "invalid_argument:true"]);
    expect(sent.filter((entry) => ["click", "drag"].includes(entry.tool))).toEqual([]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});
