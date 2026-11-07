import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  FACE_MOTION_RANK,
  goatBotFaceLabel,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import type { ScopedThreadRef } from "@goat/contracts";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";

import { GoatWordmark } from "../GoatWordmark";
import { GoatBotFace } from "./GoatBotFace";
import { useGoatBotPreferred } from "./GoatBotModeButton";
import { useGoatBotFaceMotion, useGoatBotSessionFace } from "./useGoatBotFace";
import { useGoatBotWaitingCount } from "./useGoatBotWaitingCount";

const CIRCLE = { sm: "size-5", md: "size-7", lg: "size-12" } as const;
const MARK = { sm: "size-3.5", md: "size-5", lg: "size-8" } as const;
const DOT = { sm: "size-1.5", md: "size-2", lg: "size-3" } as const;

/** GOAT Bot's face on a theme-aware neutral circle; the plain goat mark when no state is given. */
export function GoatBotAvatar({
  size = "md",
  state,
  motion,
  className,
}: {
  readonly size?: keyof typeof CIRCLE | undefined;
  readonly state?: GoatBotFaceState | undefined;
  /** Where this face sits and when its work started; it may then move while reading or working. */
  readonly motion?: { readonly rank: number; readonly since: number | null } | undefined;
  readonly className?: string;
}) {
  const label = state === undefined ? null : goatBotFaceLabel(state);
  const { watch, motion: eyeMotion } = useGoatBotFaceMotion(state, motion);
  return (
    <span
      ref={watch}
      {...(label === null ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar text-goat-avatar-foreground",
        state === "working" && "border-primary",
        state === "failed" && "border-destructive",
        CIRCLE[size],
        className,
      )}
    >
      {state === undefined ? (
        <GoatWordmark className={MARK[size]} />
      ) : (
        <GoatBotFace state={state} motion={eyeMotion} className={MARK[size]} />
      )}
      {state === "waiting" ? (
        <span className={cn("absolute top-0 right-0 rounded-full bg-warning", DOT[size])} />
      ) : null}
    </span>
  );
}

/** A bot's face from its own session thread; member bots never take the main bot's count. */
export function GoatBotSessionAvatar({
  threadRef,
  size,
  place = "rail",
}: {
  readonly threadRef: ScopedThreadRef;
  readonly size?: keyof typeof CIRCLE;
  readonly place?: "list" | "rail";
}) {
  const face = useGoatBotSessionFace(threadRef, 0, null, false);
  return (
    <GoatBotAvatar
      size={size}
      state={face.state}
      motion={{ rank: FACE_MOTION_RANK[place], since: face.since }}
    />
  );
}

/** The main GOAT Bot's face: its conversation, its waiting count and, in its chat, its activity. */
export function GoatBotMainAvatar({
  size,
  activity = null,
  chatOpen = false,
  place = "rail",
}: {
  readonly size?: keyof typeof CIRCLE;
  readonly activity?: { readonly state: "reading" | "working" } | null;
  /** The caller is the chat header: its items are already loaded and it moves first. */
  readonly chatOpen?: boolean;
  /** Where the face sits outside the chat header. */
  readonly place?: "list" | "rail";
}) {
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const waitingCount = useGoatBotWaitingCount() ?? 0;
  const threadRef = botRef === null ? null : scopeThreadRef(botRef.environmentId, botRef.threadId);
  const shell = useThreadShell(threadRef);
  // The bot-mode sidebar row loads the conversation exactly when the server tracks visits
  // (GoatBotSidebarRow), so reading it then adds no load.
  const sidebarHolds = useGoatBotPreferred() && shell?.lastVisitedAt !== undefined;
  const face = useGoatBotSessionFace(threadRef, waitingCount, activity, chatOpen || sidebarHolds);
  return (
    <GoatBotAvatar
      size={size}
      state={face.state}
      motion={{
        rank: chatOpen ? FACE_MOTION_RANK.header : FACE_MOTION_RANK[place],
        since: face.since,
      }}
    />
  );
}
