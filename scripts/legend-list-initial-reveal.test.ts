// @effect-diagnostics nodeBuiltinImport:off - reads the installed native JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const renderState = source.slice(
    source.indexOf("function setInitialRenderState("),
    source.indexOf("// src/core/finishInitialScroll.ts"),
  );
  const watchdog = source.slice(
    source.indexOf("var INSET_END_SETTLE_WATCHDOG_FRAMES"),
    source.indexOf("function dispatchInitialScroll("),
  );
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>();
  const scrollTo = vi.fn();
  const onLoad = vi.fn();
  const state = {
    props: { data: ["message"], onLoad, drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 },
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
  };
  const ctx = { state };
  let contentSize = 1200;
  let inset = 100;
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n({ start: startInsetEndSettleWatchdog, complete: setInitialRenderState })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => inset,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
    },
  ) as {
    start: (context: typeof ctx) => void;
    complete: (context: typeof ctx, flags: Record<string, boolean>) => void;
  };
  return {
    state,
    scrollTo,
    onLoad,
    start: () => api.start(ctx),
    complete: () => api.complete(ctx, {}),
    ready: () => values.get("readyToRender") === true,
    resize: (size: number) => {
      contentSize = size;
    },
    setInset: (value: number) => {
      inset = value;
    },
    advance(count: number) {
      for (let index = 0; index < count; index++) {
        const batch = frames.splice(0);
        for (const frame of batch) frame();
      }
    },
  };
}

function createWebList(bundle: string, rowCount: number) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/web/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function updateItemPositions(");
  const positionsSource = source.slice(start, source.indexOf("// src/core/viewability.ts", start));
  const data = Array.from({ length: rowCount }, (_, index) => `message-${index}`);
  let sizeReads = 0;
  const sizesKnown = new Map(data.map((id) => [id, 100]));
  const getSize = sizesKnown.get.bind(sizesKnown);
  sizesKnown.get = (id) => {
    sizeReads++;
    return getSize(id);
  };
  const state = {
    props: { data, alwaysRenderIndicesArr: [0, rowCount - 1] },
    positions: data.map((_, index) => index * 100),
    idCache: data,
    sizesKnown,
    columns: [],
    columnSpans: [],
    indexByKey: new Map(data.map((id, index) => [id, index])),
    scrollLength: 1000,
    lastScrollDelta: 500,
    minIndexSizeChanged: undefined as number | undefined,
  };
  const ctx = { state, positionListeners: new Map() };
  const updateItemPositions = NodeVM.runInNewContext(`${positionsSource}\nupdateItemPositions`, {
    IS_DEV: false,
    peek$: (_ctx: unknown, key: string) => (key === "numColumns" ? 1 : undefined),
    getId: (_state: unknown, index: number) => data[index],
    getItemSize: (_ctx: unknown, id: string) => sizesKnown.get(id),
    updateTotalSize: () => {},
  }) as (
    context: typeof ctx,
    dataChanged: boolean,
    options: {
      doMVCP: boolean;
      forceFullUpdate: boolean;
      startIndex: number;
      scrollBottomBuffered: number;
      scrollVelocity: number;
    },
  ) => void;
  return {
    state,
    update: (startIndex: number, { dataChanged = false, forceFullUpdate = false } = {}) => {
      sizeReads = 0;
      updateItemPositions(ctx, dataChanged, {
        doMVCP: false,
        forceFullUpdate,
        startIndex,
        scrollBottomBuffered: (startIndex + 10) * 100,
        scrollVelocity: 1,
      });
      return sizeReads;
    },
  };
}

describe.each(["react.js", "react.mjs"])("pinned web row layout (%s)", (bundle) => {
  it.each([10_000, 100_000])(
    "bounds unchanged-geometry scrolling with a last pin in a %i-row thread (PR #1951)",
    (rowCount) => {
      const list = createWebList(bundle, rowCount);
      for (const startIndex of [100, 200, 300]) {
        expect(list.update(startIndex)).toBeLessThan(100);
        expect(list.state.positions.at(-1)).toBe((rowCount - 1) * 100);
      }
    },
  );

  it("updates the distant pin after measured geometry changes", () => {
    const list = createWebList(bundle, 10_000);
    list.state.sizesKnown.set("message-100", 200);
    list.state.minIndexSizeChanged = 100;
    list.update(100);
    expect(list.state.positions.at(-1)).toBe(1_000_000);
  });

  it("updates the distant pin when the cached cumulative position changes", () => {
    const list = createWebList(bundle, 10_000);
    list.state.positions[99] += 100;
    list.update(100);
    expect(list.state.positions.at(-1)).toBe(1_000_000);
  });

  it.each([{ dataChanged: true }, { forceFullUpdate: true }])(
    "recomputes the tail for a full layout invalidation (%j)",
    (options) => {
      const list = createWebList(bundle, 10_000);
      list.state.sizesKnown.set("message-5000", 200);
      list.update(0, options);
      expect(list.state.positions.at(-1)).toBe(1_000_000);
    },
  );
});

describe.each(["react-native.js", "react-native.mjs"])(
  "initial inset end reveal (%s)",
  (bundle) => {
    it("waits for the native offset instead of the optimistic scroll target", () => {
      const list = createList(bundle);
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 400 });
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("does not count an in-flight scroll as stability", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = 400;
      list.state.scrollingTo = { offset: 400 };
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.scrollingTo = undefined;
      list.state.maintainingScrollAtEnd = true;
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.maintainingScrollAtEnd = false;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("waits for a stable end target even when native scrolling follows each measurement", () => {
      const list = createList(bundle);
      list.start();
      for (let index = 0; index < 10; index++) {
        list.resize(1200 + index * 10);
        list.state.lastNativeScroll = 400 + index * 10;
        list.advance(1);
      }
      expect(list.ready()).toBe(false);
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("keeps the reveal bounded when native events never arrive", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = undefined;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.advance(32);
      expect(list.ready()).toBe(true);
    });

    it("releases control on drag and never starts another initial hold", () => {
      const list = createList(bundle);
      list.start();
      list.state.didUserDrag = true;
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.complete();
      list.start();
      list.advance(20);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });
  },
);
