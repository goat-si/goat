import { scopeThreadRef } from "@goat/client-runtime/environment";
import { goatBotFaceLabel, type GoatBotFaceState } from "@goat/client-runtime/goatBot";
import type { ScopedThreadRef } from "@goat/contracts";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { cn } from "~/lib/utils";

import { GoatWordmark } from "../GoatWordmark";
import { GoatBotFace } from "./GoatBotFace";
import { useGoatBotSessionFace } from "./useGoatBotFace";
import { useGoatBotWaitingCount } from "./useGoatBotWaitingCount";

const CIRCLE = { sm: "size-5", md: "size-7", lg: "size-12" } as const;
const MARK = { sm: "size-3.5", md: "size-5", lg: "size-8" } as const;
const DOT = { sm: "size-1.5", md: "size-2", lg: "size-3" } as const;

/** GOAT Bot's face on a theme-aware neutral circle; the plain goat mark when no state is given. */
export function GoatBotAvatar({
  size = "md",
  state,
  className,
}: {
  readonly size?: keyof typeof CIRCLE | undefined;
  readonly state?: GoatBotFaceState | undefined;
  readonly className?: string;
}) {
  const label = state === undefined ? null : goatBotFaceLabel(state);
  return (
    <span
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
        <GoatBotFace state={state} className={MARK[size]} />
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
}: {
  readonly threadRef: ScopedThreadRef;
  readonly size?: keyof typeof CIRCLE;
}) {
  return <GoatBotAvatar size={size} state={useGoatBotSessionFace(threadRef, 0, null)} />;
}

/** The main GOAT Bot's face: its session shell, its waiting count and, in its chat, its activity. */
export function GoatBotMainAvatar({
  size,
  activity = null,
}: {
  readonly size?: keyof typeof CIRCLE;
  readonly activity?: { readonly state: "reading" | "working" } | null;
}) {
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const waitingCount = useGoatBotWaitingCount() ?? 0;
  const threadRef = botRef === null ? null : scopeThreadRef(botRef.environmentId, botRef.threadId);
  return (
    <GoatBotAvatar size={size} state={useGoatBotSessionFace(threadRef, waitingCount, activity)} />
  );
}
