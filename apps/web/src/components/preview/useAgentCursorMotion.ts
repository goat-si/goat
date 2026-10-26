import type { AgentCursorState } from "@goat/contracts";
import { useEffect, useRef, useState } from "react";

import {
  cursorMotionPlan,
  minimumJerkSample,
  springRetargetSample,
  type CursorPoint,
  type CursorSample,
} from "./cursorMotion";

/**
 * Glides the agent cursor mark between reported points and pulses its halo while the agent is
 * thinking, both off under reduced motion. Returns the refs for the mark and its halo.
 */
export function useAgentCursorMotion(
  left: number,
  top: number,
  sequence: number,
  cursorPhase: AgentCursorState | undefined,
) {
  const [reducedMotion, setReducedMotion] = useState(false);
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
    const node = element.current;
    if (node === null) return;
    node.dataset.cursorSequence = String(sequence);
    const target = { x: left, y: top };
    const previous = motion.current;
    const now = performance.now();
    const current =
      previous === null
        ? { ...target, vx: 0, vy: 0 }
        : previous.retarget
          ? springRetargetSample(previous.from, previous.to, now - previous.startedAt)
          : minimumJerkSample(
              previous.from,
              previous.to,
              now - previous.startedAt,
              previous.durationMs,
            );
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
    if (cursorPhase !== "thinking" || reducedMotion) return;
    const animation = node.animate(
      [
        { opacity: 0.1, transform: "scale(0.8)" },
        { opacity: 0.45, transform: "scale(1.12)" },
        { opacity: 0.1, transform: "scale(0.8)" },
      ],
      { duration: 1200, iterations: 4 },
    );
    return () => animation.cancel();
  }, [cursorPhase, sequence, reducedMotion]);

  return { element, halo };
}
