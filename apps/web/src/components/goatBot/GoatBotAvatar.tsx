import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  FACE_MOTION_RANK,
  goatBotAvatarEmoji,
  goatBotAvatarSignal,
  goatBotFaceLabel,
  type GoatBotAvatarSignal,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import type { BotProfile, ScopedThreadRef } from "@goat/contracts";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";

import { GoatWordmark } from "../GoatWordmark";
import { GoatBotFace } from "./GoatBotFace";
import { useGoatBotPreferred } from "./GoatBotModeButton";
import { useGoatBotFaceMotion, useGoatBotSessionFace } from "./useGoatBotFace";
import { useGoatBotWaitingCount } from "./useGoatBotWaitingCount";
import { useGoatBotMemberWaitingCount } from "./useGoatBotMemberStatus";

const CIRCLE = { sm: "size-5", md: "size-7", lg: "size-12" } as const;
const MARK = { sm: "size-3.5", md: "size-5", lg: "size-8" } as const;
const DOT = { sm: "size-1.5", md: "size-2", lg: "size-3" } as const;
const EMOJI = { sm: "text-[0.6875rem]", md: "text-sm", lg: "text-2xl" } as const;
const RING: Record<NonNullable<GoatBotAvatarSignal["ring"]>, string> = {
  active: "border-primary",
  failed: "border-destructive",
  finished: "border-success-foreground",
};

/**
 * A bot on a theme-aware neutral circle: its chosen emoji, else its face, else the plain goat mark
 * when no state is given. The ring and dot carry the state either way.
 */
export function GoatBotAvatar({
  size = "md",
  state,
  motion,
  emoji = null,
  className,
}: {
  readonly size?: keyof typeof CIRCLE | undefined;
  readonly state?: GoatBotFaceState | undefined;
  /** Where this face sits and when its work started; it may then move while reading or working. */
  readonly motion?: { readonly rank: number; readonly since: number | null } | undefined;
  /** The bot's profile avatar; an emoji replaces the drawn face. */
  readonly emoji?: string | null | undefined;
  readonly className?: string;
}) {
  const label = state === undefined ? null : goatBotFaceLabel(state);
  const picture = goatBotAvatarEmoji(emoji);
  const signal = state === undefined ? null : goatBotAvatarSignal(state, picture !== null);
  // An emoji has no eyes to move, so it never takes the one moving face.
  const { watch, motion: eyeMotion } = useGoatBotFaceMotion(
    picture === null ? state : undefined,
    picture === null ? motion : undefined,
  );
  return (
    <span
      ref={watch}
      {...(label === null ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar text-goat-avatar-foreground",
        signal?.ring && RING[signal.ring],
        CIRCLE[size],
        className,
      )}
    >
      {picture !== null ? (
        <span
          aria-hidden
          className={cn("leading-none select-none", EMOJI[size], signal?.dimmed && "opacity-50")}
        >
          {picture}
        </span>
      ) : state === undefined ? (
        <GoatWordmark className={MARK[size]} />
      ) : (
        <GoatBotFace state={state} motion={eyeMotion} className={MARK[size]} />
      )}
      {signal?.waitingDot ? (
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
  waitingCount = 0,
  activity = null,
  chatOpen = false,
  emoji = null,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly size?: keyof typeof CIRCLE | undefined;
  readonly place?: "list" | "rail";
  /** This bot's own count of tasks waiting on a person. */
  readonly waitingCount?: number;
  readonly activity?: { readonly state: "reading" | "working" } | null;
  /** The caller is this bot's chat header: its items are already loaded and it moves first. */
  readonly chatOpen?: boolean;
  /** The bot's profile avatar. */
  readonly emoji?: string | null | undefined;
}) {
  const face = useGoatBotSessionFace(threadRef, waitingCount, activity, chatOpen);
  return (
    <GoatBotAvatar
      size={size}
      state={face.state}
      emoji={emoji}
      motion={{
        rank: chatOpen ? FACE_MOTION_RANK.header : FACE_MOTION_RANK[place],
        since: face.since,
      }}
    />
  );
}

/** The main GOAT Bot's face: its conversation, its waiting count and, in its chat, its activity. */
export function GoatBotMainAvatar({
  size,
  activity = null,
  chatOpen = false,
  place = "rail",
  emoji = null,
}: {
  readonly size?: keyof typeof CIRCLE;
  readonly activity?: { readonly state: "reading" | "working" } | null;
  /** The caller is the chat header: its items are already loaded and it moves first. */
  readonly chatOpen?: boolean;
  /** Where the face sits outside the chat header. */
  readonly place?: "list" | "rail";
  /** The main bot's profile avatar. */
  readonly emoji?: string | null | undefined;
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
      emoji={emoji}
      motion={{
        rank: chatOpen ? FACE_MOTION_RANK.header : FACE_MOTION_RANK[place],
        since: face.since,
      }}
    />
  );
}

/**
 * A member bot outside its chat, with its own waiting count. Without an emoji it shows its name's
 * first letter, so members on the rail are told apart from each other and from the main bot.
 */
export function GoatBotMemberAvatar({
  bot,
  size,
  place = "rail",
}: {
  readonly bot: BotProfile;
  readonly size?: keyof typeof CIRCLE;
  readonly place?: "list" | "rail";
}) {
  const waitingCount = useGoatBotMemberWaitingCount(bot);
  return (
    <GoatBotSessionAvatar
      size={size}
      place={place}
      waitingCount={waitingCount}
      emoji={goatBotAvatarEmoji(bot.avatar) ?? initialOf(bot.name)}
      threadRef={scopeThreadRef(bot.environmentId, bot.sessionThreadId)}
    />
  );
}

function initialOf(name: string): string | null {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? null;
}
