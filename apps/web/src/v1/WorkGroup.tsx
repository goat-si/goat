/* Adapted from apps/web/src/components/chat/TimelineWorkGroupRows.tsx@916b5cc — dropped: virtual scrolling, worktree setup, rich tool details and runtime context. */
import { useEffect, useState } from "react";
import { cn } from "./cn.ts";

type Step = { key: string; verb: string; detail: string; extra?: string; status: string };
export type WorkGroupProps = { status: "worked" | "stopped" | "continued" | "working"; duration: string | null; startedAt?: string; steps: Step[]; defaultOpen?: boolean };
function elapsed(start: string) { const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 1000)); return Number.isFinite(seconds) ? seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s` : "0s"; }
export function WorkGroup({ status, duration, startedAt, steps, defaultOpen = false }: WorkGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [time, setTime] = useState(() => startedAt ? elapsed(startedAt) : duration);
  useEffect(() => { if (status !== "working" || !startedAt) return; const tick = () => setTime(elapsed(startedAt)); tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer); }, [status, startedAt]);
  const label = status === "working" ? (startedAt || duration ? `Working for ${startedAt ? time : duration}` : "Working...") : status === "worked" ? duration ? `Worked for ${duration}` : "Worked" : status === "continued" ? duration ? `Continued for ${duration}` : "Continued" : duration ? `You stopped after ${duration}` : "You stopped this response";
  return <div className="v1 border-b border-border/60 pb-2 pt-1">
    <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-work-log text-secondary-label/85 tabular-nums">
      {status === "working" ? <span className="relative shrink-0 overflow-hidden whitespace-nowrap">{label}<span aria-hidden="true" className="v1-shimmer pointer-events-none absolute inset-y-0 select-none">{label}</span></span> : <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="relative shrink-0 overflow-hidden whitespace-nowrap">{label} <span aria-hidden="true">{open ? "⌄" : "›"}</span></button>}
    </div>
    {open && <section aria-label="Activity"><div className="flex min-w-0 flex-col">{steps.map(step => <div key={step.key} className="group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors py-0"><div className="flex min-h-6 min-w-0 gap-1.5 text-work-log items-center"><div className="flex min-w-0 flex-1 items-baseline gap-px"><span className="relative w-6 shrink-0 leading-0 select-none"><span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]"><span className="flex size-full items-center justify-center">·</span></span></span><div className="min-w-0 flex-1 text-secondary-label/85 select-text truncate [&_*]:whitespace-nowrap"><span>{step.verb} </span><span className="text-foreground">{step.detail}</span>{step.extra && <span> {step.extra}</span>}</div></div></div></div>)}</div></section>}
  </div>;
}
