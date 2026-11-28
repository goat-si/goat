import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotFace } from "./BotFace.tsx";
import { DEFAULT_FACE, faceFromId, SHAPES } from "./shapes.ts";

let container: HTMLDivElement;
let root: Root;
let pending: Map<number, FrameRequestCallback>;
let nextId: number;
let observers: ((visible: boolean) => void)[];
let reduced = false;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  pending = new Map(); nextId = 0; observers = []; reduced = false;
  vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => { pending.set(++nextId, cb); return nextId; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => pending.delete(id)));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("IntersectionObserver", class { constructor(cb: IntersectionObserverCallback) { observers.push(visible => cb([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); } observe() {} disconnect() {} });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function render(face = DEFAULT_FACE, mood: "idle" | "work" = "idle") { act(() => root.render(<BotFace face={face} size={24} mood={mood} />)); }
describe("BotFace", () => {
  it("renders each exported shape with or without GOAT features", () => {
    for (const shape of Object.keys(SHAPES)) for (const goat of [true, false]) {
      render({ ...DEFAULT_FACE, shape, goat });
      expect(container.querySelector("svg path[data-part=body]")?.getAttribute("d")).toBe(SHAPES[shape as keyof typeof SHAPES].body);
      expect(container.querySelectorAll("[data-part=eye]")).toHaveLength(2);
      expect(container.querySelectorAll("svg path")).toHaveLength(goat ? 5 : 3);
    }
  });
  it("uses defaults for unknown shape and color", () => {
    render({ shape: "missing", color: "missing", goat: true });
    expect(container.querySelector("[data-part=body]")?.getAttribute("d")).toBe(SHAPES.squircle.body);
    expect(container.querySelector("[data-part=body]")?.getAttribute("fill")).toBe("#18181B");
  });
  it("maps IDs deterministically", () => { expect(faceFromId("a bot")).toEqual(faceFromId("a bot")); expect(Object.keys(SHAPES)).toContain(faceFromId("a bot").shape); });
  it("draws reduced work still without scheduling", () => {
    reduced = true; render(DEFAULT_FACE, "work");
    expect(container.querySelector("svg > g")?.getAttribute("transform")).toContain("rotate(0)");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
  it("starts only when visible and cancels the last pending frame on unmount", () => {
    render(DEFAULT_FACE, "work"); expect(pending.size).toBe(0);
    act(() => observers.forEach(observer => observer(true))); expect(pending.size).toBe(1);
    act(() => root.unmount()); expect(pending.size).toBe(0); expect(cancelAnimationFrame).toHaveBeenCalled();
    root = createRoot(container);
  });
  it("shares a frame and throttles list faces", () => {
    act(() => root.render(<><BotFace face={DEFAULT_FACE} size={40} mood="work" /><BotFace face={DEFAULT_FACE} size={40} mood="work" /></>));
    act(() => observers.forEach(observer => observer(true)));
    expect(pending.size).toBe(1);
    const head = container.querySelectorAll("svg > g")[1]!;
    const advance = (ms: number) => { const [id, cb] = [...pending][0]!; pending.delete(id); act(() => cb(ms)); };
    const now = performance.now();
    advance(now + 50); const first = head.getAttribute("transform");
    advance(now + 500); expect(head.getAttribute("transform")).toBe(first);
    advance(now + 1100); expect(head.getAttribute("transform")).not.toBe(first);
  });
  it("cancels and restarts when visibility changes", () => {
    render(DEFAULT_FACE, "work"); act(() => observers.forEach(observer => observer(true))); expect(pending.size).toBe(1);
    act(() => observers.forEach(observer => observer(false))); expect(pending.size).toBe(0);
    act(() => observers.forEach(observer => observer(true))); expect(pending.size).toBe(1);
  });
});
