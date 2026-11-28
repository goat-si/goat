import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BotFace as BotFaceProfile } from "../../contracts-rs/src/generated/BotFace.ts";
import { blendPose, facePose, reducedPose, type BotMood, type FacePose } from "./facePose.ts";
import { FACE_CLOCK_FPS, MOOD_BLEND_SECONDS, STATIC_IDLE_MAX_PX } from "./motionTokens.ts";
import { COLORS, DEFAULT_FACE, HAPPY_EYES, HORNS_PATH, SHAPES, SHUT_EYES } from "./shapes.ts";

type Listener = { visible: boolean; tick: (ms: number) => void };
const listeners = new Set<Listener>();
let frame: number | null = null;
let lastFrame = -Infinity;
function schedule() {
  if (frame === null && !document.hidden && [...listeners].some(x => x.visible)) frame = requestAnimationFrame(tick);
}
function tick(ms: number) {
  frame = null;
  if (document.hidden) return;
  if (ms - lastFrame >= 1000 / FACE_CLOCK_FPS) {
    lastFrame = ms;
    for (const listener of listeners) if (listener.visible) listener.tick(ms);
  }
  schedule();
}
function reconcile() {
  if (document.hidden || ![...listeners].some(x => x.visible)) {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    lastFrame = -Infinity;
  } else schedule();
}
function register(listener: Listener) {
  if (!listeners.size) document.addEventListener("visibilitychange", reconcile);
  listeners.add(listener); reconcile();
  return () => {
    listeners.delete(listener); reconcile();
    if (!listeners.size) document.removeEventListener("visibilitychange", reconcile);
  };
}

export interface BotFaceProps {
  face: BotFaceProfile;
  size: number;
  mood: BotMood;
  tier?: "live" | "list";
  onDark?: boolean;
  title?: string;
}

export function BotFace({ face, size, mood, tier = "list", onDark = false, title }: BotFaceProps) {
  const svg = useRef<SVGSVGElement>(null);
  const head = useRef<SVGGElement>(null);
  const eyes = useRef<SVGGElement>(null);
  const open = useRef<SVGGElement>(null);
  const happy = useRef<SVGPathElement>(null);
  const shut = useRef<SVGPathElement>(null);
  const lastPose = useRef<FacePose>(reducedPose(mood));
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const shape = SHAPES[Object.hasOwn(SHAPES, face.shape) ? face.shape as keyof typeof SHAPES : DEFAULT_FACE.shape as keyof typeof SHAPES];
  const colorId = Object.hasOwn(COLORS, face.color) ? face.color as keyof typeof COLORS : "zinc";
  const inverted = onDark && colorId === "zinc";
  const body = inverted ? "#F4F4F5" : COLORS[colorId].hex;
  const ink = inverted ? "#18181B" : "#FFFFFF";

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    change(); media.addEventListener?.("change", change);
    return () => media.removeEventListener?.("change", change);
  }, []);

  useLayoutEffect(() => {
    const paint = (pose: FacePose) => {
      lastPose.current = pose;
      head.current?.setAttribute("transform", `translate(0 ${-pose.hop}) translate(20 25) rotate(${pose.roll * 0.25}) skewX(${pose.turn * 0.15}) skewY(${pose.tilt * 0.15}) translate(-20 -25)`);
      eyes.current?.setAttribute("transform", `translate(${pose.gazeX * 0.2} ${pose.gazeY * 0.2})`);
      open.current?.setAttribute("display", pose.eyes === "open" && !pose.blink ? "inline" : "none");
      happy.current?.setAttribute("display", pose.eyes === "happy" ? "inline" : "none");
      shut.current?.setAttribute("display", pose.eyes === "shut" || pose.blink ? "inline" : "none");
    };
    const from = lastPose.current;
    const start = performance.now();
    if (reduced || (mood === "idle" && size <= STATIC_IDLE_MAX_PX)) { paint(reducedPose(mood)); return; }
    let lastPaint = -Infinity;
    paint(blendPose(from, facePose(mood, start / 1000, 0), 0, MOOD_BLEND_SECONDS));
    const listener: Listener = { visible: typeof IntersectionObserver === "undefined", tick(ms) {
      if (tier === "list" && ms - lastPaint < 1000) return;
      lastPaint = ms;
      paint(blendPose(from, facePose(mood, ms / 1000, Math.max(0, (ms - start) / 1000)), (ms - start) / 1000, MOOD_BLEND_SECONDS));
    } };
    const unregister = register(listener);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      listener.visible = entries.some(entry => entry.isIntersecting); reconcile();
    });
    if (svg.current) observer?.observe(svg.current);
    return () => { observer?.disconnect(); unregister(); };
  }, [mood, size, tier, reduced]);

  const eyeY = Number(shape.eyes[0].y) - 20.5;
  return <svg ref={svg} width={size} height={size} viewBox="0 0 40 40" overflow="visible" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} style={{ display: "inline-block", flexShrink: 0 }}>
    <g ref={head}>
      {face.goat && <path d={HORNS_PATH} transform={shape.hornsTransform} fill={body} stroke={body} strokeWidth="0.9" strokeLinejoin="round" />}
      <g transform={face.goat ? undefined : "translate(0 -4)"}>
        <path d={shape.body} fill={body} data-part="body" />
        {face.goat && <ellipse cx="20" cy={shape.tuftY} rx="3.2" ry="2.6" fill={body} />}
        <g ref={eyes}>
          <g ref={open}>{shape.eyes.map((eye, i) => <rect key={i} data-part="eye" x={eye.x} y={eye.y} width="3.2" height="6.6" rx="1.6" fill={ink} />)}</g>
          <path ref={happy} d={HAPPY_EYES} transform={`translate(0 ${eyeY})`} display="none" fill="none" stroke={ink} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
          <path ref={shut} d={SHUT_EYES} transform={`translate(0 ${eyeY})`} display="none" fill="none" stroke={ink} strokeWidth="2.1" strokeLinecap="round" />
        </g>
        {face.goat && <path d={shape.snout} fill="none" stroke={ink} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
      </g>
    </g>
  </svg>;
}
