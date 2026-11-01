import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  CheckIcon,
  CircleArrowUpIcon,
  DownloadIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "~/components/solar";
import type { AnimationEventHandler } from "react";

const DOWNLOAD_PROGRESS_RADIUS = 14;
const DOWNLOAD_PROGRESS_CIRCUMFERENCE = 2 * Math.PI * DOWNLOAD_PROGRESS_RADIUS;

export type DesktopUpdateStatusIconState =
  | "idle"
  | "checking"
  | "check-failed"
  | "available"
  | "downloading"
  | "downloaded"
  | "everything";

function normalizeDesktopUpdateDownloadPercent(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

export function shouldShowDesktopUpdateCheckIcon({
  isAnimationLatched,
  isChecking,
  prefersReducedMotion,
}: {
  readonly isAnimationLatched: boolean;
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking || (isAnimationLatched && !prefersReducedMotion);
}

export function shouldContinueDesktopUpdateCheckAnimation({
  isChecking,
  prefersReducedMotion,
}: {
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking && !prefersReducedMotion;
}

export type DesktopUpdateStatusIconSize = "sm" | "md";

/** The footer pill draws 16px glyphs; the destination rail matches its 20px icons. */
function glyphSize(size: DesktopUpdateStatusIconSize) {
  return size === "md" ? "size-5" : "size-4";
}

function DesktopUpdateAvailableIcon({ size }: { readonly size: DesktopUpdateStatusIconSize }) {
  return (
    <span className={`relative grid place-items-center ${glyphSize(size)}`}>
      <DownloadIcon className={glyphSize(size)} />
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current ring-2 ring-sidebar-control-surface"
      />
    </span>
  );
}

function DesktopUpdateDownloadingIcon({
  percent,
  size,
}: {
  readonly percent: number | null;
  readonly size: DesktopUpdateStatusIconSize;
}) {
  const normalizedPercent = normalizeDesktopUpdateDownloadPercent(percent);
  const progressOffset = DOWNLOAD_PROGRESS_CIRCUMFERENCE * (1 - normalizedPercent / 100);

  return (
    <span className="relative grid size-8 place-items-center">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full -rotate-90"
        viewBox="0 0 32 32"
      >
        <circle
          cx="16"
          cy="16"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          className="stroke-current/22"
          strokeWidth="1.5"
        />
        <circle
          cx="16"
          cy="16"
          r={DOWNLOAD_PROGRESS_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeDasharray={DOWNLOAD_PROGRESS_CIRCUMFERENCE}
          strokeDashoffset={progressOffset}
          strokeLinecap="round"
          strokeWidth="1.5"
          className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        />
      </svg>
      <DownloadIcon className={glyphSize(size)} />
    </span>
  );
}

function DesktopUpdateDownloadedIcon({ size }: { readonly size: DesktopUpdateStatusIconSize }) {
  return (
    <span className={`relative grid place-items-center ${glyphSize(size)}`}>
      <RotateCwIcon className={glyphSize(size)} />
      <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background">
        <CheckIcon className="size-2" strokeWidth={3} />
      </span>
    </span>
  );
}

export function DesktopUpdateStatusIcon({
  downloadPercent,
  isCheckAnimating,
  onCheckAnimationIteration,
  size = "sm",
  status,
}: {
  readonly downloadPercent?: number | null;
  readonly isCheckAnimating?: boolean;
  readonly onCheckAnimationIteration?: AnimationEventHandler<SVGSVGElement>;
  readonly size?: DesktopUpdateStatusIconSize;
  readonly status: DesktopUpdateStatusIconState;
}) {
  if (status === "available") return <DesktopUpdateAvailableIcon size={size} />;
  if (status === "downloading") {
    return <DesktopUpdateDownloadingIcon percent={downloadPercent ?? null} size={size} />;
  }
  if (status === "downloaded") return <DesktopUpdateDownloadedIcon size={size} />;
  if (status === "everything") return <CircleArrowUpIcon className={glyphSize(size)} />;
  if (status === "check-failed") {
    return <TriangleAlertIcon className={`${glyphSize(size)} text-warning`} />;
  }

  return (
    <RefreshIcon
      className={size === "md" ? "size-5" : "size-4"}
      refreshing={status === "checking" && isCheckAnimating === true}
      onAnimationIteration={onCheckAnimationIteration}
    />
  );
}
