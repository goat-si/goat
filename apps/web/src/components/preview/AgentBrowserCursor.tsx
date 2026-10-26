import type { DesktopPreviewPointerEvent } from "@goat/contracts";
import { MousePointerIcon as MousePointer2 } from "~/components/solar";
import { useEffect, useRef, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

import { agentBrowserCursorOpacity, type BrowserController } from "./agentBrowserCursorLogic";
import {
  cursorMotionPlan,
  minimumJerkSample,
  springRetargetSample,
  type CursorPoint,
  type CursorSample,
} from "./cursorMotion";
import type { AgentCursorState } from "@goat/contracts";

const CURSOR_ACTIVE_MS = 700;

export function AgentBrowserCursor(props: {
  readonly tabId: string;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { tabId, zoomFactor, controller } = props;
  const event = useBrowserPointerStore((state) => state.byTabId[tabId] ?? null);
  const content = useBrowserSurfaceStore((state) => state.byTabId[tabId]?.content ?? null);

  if (!event) return null;

  return (
    <AgentBrowserCursorEvent
      event={event}
      content={content}
      zoomFactor={zoomFactor}
      controller={controller}
    />
  );
}

function AgentBrowserCursorEvent(props: {
  readonly event: DesktopPreviewPointerEvent;
  readonly content: {
    readonly x: number;
    readonly y: number;
    readonly scale: number;
    readonly scrollLeft: number;
    readonly scrollTop: number;
  } | null;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { event, content, zoomFactor, controller } = props;
  const scale = zoomFactor * (content?.scale ?? 1);
  return (
    <AgentCursorMark
      phase={event.phase}
      {...(event.cursor ? { cursorPhase: event.cursor.phase } : {})}
      sequence={event.sequence}
      left={event.x * scale + (content?.x ?? 0) - (content?.scrollLeft ?? 0)}
      top={event.y * scale + (content?.y ?? 0) - (content?.scrollTop ?? 0)}
      controller={controller}
    />
  );
}

export function AgentCursorMark(props: {
  readonly phase: "move" | "click";
  readonly cursorPhase?: AgentCursorState;
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
  readonly controller: BrowserController;
}) {
  const { phase, cursorPhase, sequence, left, top, controller } = props;
  const [inactiveSequence, setInactiveSequence] = useState<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const active = inactiveSequence !== sequence;
  const element = useRef<HTMLDivElement>(null);
  const halo = useRef<HTMLSpanElement>(null);
  const motion = useRef<{
    from: CursorSample;
    to: CursorPoint;
    startedAt: number;
    durationMs: number;
    retarget: boolean;
  } | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (cursorPhase !== undefined) return;
    const timeout = window.setTimeout(() => setInactiveSequence(sequence), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [cursorPhase, sequence]);

  useEffect(() => {
    const node = element.current;
    if (node === null) return;
    node.dataset.cursorSequence = String(sequence);
    const target = { x: left, y: top };
    const previous = motion.current;
    const now = performance.now();
    const current = previous === null
      ? { ...target, vx: 0, vy: 0 }
      : previous.retarget
        ? springRetargetSample(previous.from, previous.to, now - previous.startedAt)
        : minimumJerkSample(previous.from, previous.to, now - previous.startedAt, previous.durationMs);
    node.getAnimations().forEach((animation) => animation.cancel());
    const plan = cursorMotionPlan(reducedMotion, current, target);
    node.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    if (plan.kind === "teleport") {
      node.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: plan.durationMs });
      motion.current = null;
      return;
    }
    if (plan.durationMs === 0) {
      motion.current = null;
      return;
    }
    const retarget = previous !== null && now - previous.startedAt < previous.durationMs;
    const durationMs = retarget ? 600 : plan.durationMs;
    const samples = Array.from({ length: 21 }, (_, index) => {
      const sample = retarget
        ? springRetargetSample(current, target, (durationMs * index) / 20)
        : minimumJerkSample(current, target, (durationMs * index) / 20, durationMs);
      return { transform: `translate3d(${sample.x}px, ${sample.y}px, 0)`, offset: index / 20 };
    });
    node.animate(samples, { duration: durationMs, easing: "linear" });
    motion.current = { from: current, to: target, startedAt: now, durationMs, retarget };
    return () => node.getAnimations().forEach((animation) => animation.cancel());
  }, [left, top, sequence, reducedMotion]);

  useEffect(() => {
    const node = halo.current;
    if (node === null) return;
    node.dataset.cursorSequence = String(sequence);
    node.getAnimations().forEach((animation) => animation.cancel());
    if (cursorPhase !== "thinking" || reducedMotion)
      return;
    const animation = node.animate(
      [{ opacity: 0.1, transform: "scale(0.8)" }, { opacity: 0.45, transform: "scale(1.12)" }, { opacity: 0.1, transform: "scale(0.8)" }],
      { duration: 1200, iterations: 4 },
    );
    return () => animation.cancel();
  }, [cursorPhase, sequence, reducedMotion]);

  if (cursorPhase === "hidden" || cursorPhase === "yielded") return null;

  return (
    <div
      ref={element}
      className="pointer-events-none absolute left-0 top-0 z-40"
      style={{
        opacity: agentBrowserCursorOpacity(cursorPhase === undefined ? active : cursorPhase !== "resting", controller),
        transform: `translate3d(${left}px, ${top}px, 0)`,
      }}
      aria-hidden="true"
      data-agent-browser-cursor
      data-phase={cursorPhase ?? phase}
    >
      <span ref={halo} className="absolute left-0.5 top-0.5 size-4 rounded-full bg-primary/25" style={{ opacity: cursorPhase === "thinking" ? 0.1 : 0 }} />
      {phase === "click" && cursorPhase === undefined ? (
        <span
          key={sequence}
          className="absolute left-0.5 top-0.5 size-4 rounded-full bg-primary/25"
        />
      ) : null}
      <MousePointer2 className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-background stroke-2 text-primary drop-shadow-sm" />
    </div>
  );
}
