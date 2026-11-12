import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  FACE_MOTION_RANK,
  goatBotAccent,
  goatBotAvatarEmoji,
  goatBotAvatarSignal,
  goatBotFaceSpoken,
  goatBotMemberPicture,
  type GoatBotAccent,
  type GoatBotAvatarSignal,
  type GoatBotFaceState,
  type GoatBotRowStatus,
} from "@goat/client-runtime/goatBot";
import type { BotProfile, ScopedThreadRef } from "@goat/contracts";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";

import { GoatBotFace } from "./GoatBotFace";
import { useGoatBotPreferred } from "./GoatBotModeButton";
import { useGoatBotFaceMotion, useGoatBotSessionFace } from "./useGoatBotFace";
import { useGoatBotWaitingCount } from "./useGoatBotWaitingCount";
import { useGoatBotMemberStatus } from "./useGoatBotMemberStatus";

const CIRCLE = { sm: "size-5", md: "size-7", lg: "size-12" } as const;
// The head nearly fills its circle so its ears and eyes still read at 20 px.
const HEAD = { sm: "size-4.5", md: "size-6", lg: "size-10" } as const;
const DOT = { sm: "size-1.5", md: "size-2", lg: "size-3" } as const;
const EMOJI = { sm: "text-[0.6875rem]", md: "text-sm", lg: "text-2xl" } as const;
const RING: Record<NonNullable<GoatBotAvatarSignal["ring"]>, string> = {
  active: "border-primary",
  failed: "border-destructive",
  finished: "border-success-foreground",
};

/**
 * A bot on a theme-aware neutral circle: its chosen emoji, else its face, still and idle when no
 * state is given. A member's color fills the circle behind its picture. The ring and dot carry
 * the state either way.
 */
export function GoatBotAvatar({
  size = "md",
  state,
  motion,
  emoji = null,
  accent = null,
  spokenCount = 0,
  className,
}: {
  readonly size?: keyof typeof CIRCLE | undefined;
  readonly state?: GoatBotFaceState | undefined;
  /** Where this face sits and when its work started; it may then move while reading or working. */
  readonly motion?: { readonly rank: number; readonly since: number | null } | undefined;
  /** The bot's profile avatar; an emoji replaces the drawn face. */
  readonly emoji?: string | null | undefined;
  /** A member's color, with text that reads on it; the face itself stays on the neutral circle. */
  readonly accent?: GoatBotAccent | null | undefined;
  /** The row's waiting count when the label says it, so the row says waiting once. */
  readonly spokenCount?: number | undefined;
  readonly className?: string;
}) {
  const label = state === undefined ? null : goatBotFaceSpoken(state, spokenCount);
  const picture = goatBotAvatarEmoji(emoji);
  const signal = state === undefined ? null : goatBotAvatarSignal(state, picture !== null);
  const fill = picture !== null ? accent : null;
  // On a color the letter keeps its contrast, so a sleeping member dims the whole circle instead.
  const dimCircle = signal?.dimmed === true && fill !== null;
  // An emoji has no eyes to move, so it never takes the one moving face.
  const { watch, motion: eyeMotion } = useGoatBotFaceMotion(
    picture === null ? state : undefined,
    picture === null ? motion : undefined,
  );
  return (
    <span
      ref={watch}
      {...(label === null ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      style={
        fill === null ? undefined : { backgroundColor: fill.background, color: fill.foreground }
      }
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar text-goat-avatar-foreground",
        fill !== null && "border-transparent",
        dimCircle && "opacity-60",
        signal?.ring && RING[signal.ring],
        CIRCLE[size],
        className,
      )}
    >
      {picture !== null ? (
        <span
          aria-hidden
          className={cn(
            "leading-none select-none",
            EMOJI[size],
            signal?.dimmed && !dimCircle && "opacity-50",
          )}
        >
          {picture}
        </span>
      ) : (
        <GoatBotFace state={state ?? "idle"} motion={eyeMotion} className={HEAD[size]} />
      )}
      {signal?.waitingDot ? (
        <span className={cn("absolute top-0 right-0 rounded-full bg-warning", DOT[size])} />
      ) : null}
    </span>
  );
}

/**
 * A bot's face from its own session thread; member bots never take the main bot's count. A roster
 * row passes its bot status, which shows reading without loading the conversation.
 */
export function GoatBotSessionAvatar({
  threadRef,
  size,
  place = "rail",
  waitingCount = 0,
  activity = null,
  chatOpen = false,
  emoji = null,
  accent = null,
  row,
  countInLabel = false,
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
  readonly accent?: GoatBotAccent | null | undefined;
  readonly row?: GoatBotRowStatus | undefined;
  /** The row hides its own waiting badge from assistive technology; the label says the count. */
  readonly countInLabel?: boolean;
}) {
  const face = useGoatBotSessionFace(threadRef, waitingCount, activity, chatOpen, row);
  return (
    <GoatBotAvatar
      size={size}
      state={face.state}
      emoji={emoji}
      accent={accent}
      spokenCount={countInLabel ? waitingCount : 0}
      motion={{
        rank: chatOpen ? FACE_MOTION_RANK.header : FACE_MOTION_RANK[place],
        since: face.since,
      }}
    />
  );
}

/** What a bot's face shows, when its work started, and its waiting count, for a caller's label. */
export interface GoatBotShownFace {
  readonly state: GoatBotFaceState;
  readonly since: number | null;
  readonly waitingCount: number;
}

/** The main GOAT Bot's face: its conversation, its waiting count and, in its chat, its activity. */
export function useGoatBotMainFace(
  activity: { readonly state: "reading" | "working" } | null,
  chatOpen: boolean,
): GoatBotShownFace {
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const waitingCount = useGoatBotWaitingCount() ?? 0;
  const threadRef = botRef === null ? null : scopeThreadRef(botRef.environmentId, botRef.threadId);
  const shell = useThreadShell(threadRef);
  // The bot-mode sidebar row loads the conversation exactly when the server tracks visits
  // (GoatBotSidebarRow), so reading it then adds no load.
  const sidebarHolds = useGoatBotPreferred() && shell?.lastVisitedAt !== undefined;
  const face = useGoatBotSessionFace(threadRef, waitingCount, activity, chatOpen || sidebarHolds);
  return { ...face, waitingCount };
}

export function GoatBotMainAvatar({
  size,
  activity = null,
  chatOpen = false,
  place = "rail",
  emoji = null,
  countInLabel = false,
}: {
  readonly size?: keyof typeof CIRCLE;
  readonly activity?: { readonly state: "reading" | "working" } | null;
  /** The caller is the chat header: its items are already loaded and it moves first. */
  readonly chatOpen?: boolean;
  /** Where the face sits outside the chat header. */
  readonly place?: "list" | "rail";
  /** The main bot's profile avatar. */
  readonly emoji?: string | null | undefined;
  /** The row hides its own waiting badge from assistive technology; the label says the count. */
  readonly countInLabel?: boolean;
}) {
  const face = useGoatBotMainFace(activity, chatOpen);
  return (
    <GoatBotAvatar
      size={size}
      state={face.state}
      emoji={emoji}
      spokenCount={countInLabel ? face.waitingCount : 0}
      motion={{
        rank: chatOpen ? FACE_MOTION_RANK.header : FACE_MOTION_RANK[place],
        since: face.since,
      }}
    />
  );
}

/** A member bot's face outside its chat, from its own status: waiting count and newest message. */
export function useGoatBotMemberFace(bot: BotProfile): GoatBotShownFace {
  const status = useGoatBotMemberStatus(bot);
  const face = useGoatBotSessionFace(
    scopeThreadRef(bot.environmentId, bot.sessionThreadId),
    status.waitingCount,
    null,
    false,
    status,
  );
  return { ...face, waitingCount: status.waitingCount };
}

/**
 * A member bot's avatar for a face its caller already holds. Without an emoji it shows its name's
 * first letter on its color, so members are told apart from each other and from the main bot.
 */
export function GoatBotMemberAvatar({
  bot,
  face,
  size,
  place = "rail",
}: {
  readonly bot: BotProfile;
  readonly face: GoatBotShownFace;
  readonly size?: keyof typeof CIRCLE;
  readonly place?: "list" | "rail";
}) {
  return (
    <GoatBotAvatar
      size={size}
      state={face.state}
      emoji={goatBotMemberPicture(bot)}
      accent={goatBotAccent(bot)}
      motion={{ rank: FACE_MOTION_RANK[place], since: face.since }}
    />
  );
}
