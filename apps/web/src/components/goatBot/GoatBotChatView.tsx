import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { isElectron } from "~/env";
import type { GlobalAgentLegacyRoute } from "~/globalAgentRoute";

import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { GoatBotComposer } from "./GoatBotComposer";
import { GoatBotTimeline } from "./GoatBotTimeline";
import { canSendToGoatBot, type GoatBotAvailability } from "./goatBotAvailability";
import type { GoatBotRow } from "./goatBotRows";

export const GOAT_BOT_TITLE = "GOAT Bot";

export interface GoatBotChatViewProps {
  readonly availability: GoatBotAvailability;
  readonly canOperate: boolean;
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly onSend: (text: string) => void;
  readonly onRetryInput: (clientKey: string) => void;
  /** Asks the server for its bot again, after a failure or a busy global agent. */
  readonly onRetryAvailability?: (() => void) | undefined;
  /** The old global agent, which keeps its coding view and history. */
  readonly legacyAgentRoute: GlobalAgentLegacyRoute | null;
}

/** GOAT Bot as a messenger: bubbles and work cards, never tool calls. */
export function GoatBotChatView({
  availability,
  canOperate,
  rows,
  onSend,
  onRetryInput,
  onRetryAvailability,
  legacyAgentRoute,
}: GoatBotChatViewProps) {
  const ready = availability.kind === "ready";
  const canSend = canSendToGoatBot(availability, canOperate);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <div className="flex min-w-0 items-center gap-2.5">
          <GoatBotAvatar size="md" />
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-sm font-medium text-foreground">{GOAT_BOT_TITLE}</h1>
            <p className="truncate text-xs text-muted-foreground">{statusLine(availability)}</p>
          </div>
        </div>
      </WorkspacePageHeader>
      {ready && rows.length > 0 ? (
        <GoatBotTimeline rows={rows} onRetry={onRetryInput} />
      ) : (
        <GoatBotNotice
          availability={availability}
          onRetryAvailability={onRetryAvailability}
          legacyAgentRoute={legacyAgentRoute}
        />
      )}
      {ready && !canOperate ? (
        <p className="mx-auto w-full max-w-3xl px-4 pb-2 text-xs text-muted-foreground">
          You can read this chat but can't send messages.
        </p>
      ) : null}
      <GoatBotComposer
        disabled={!canSend}
        placeholder={canSend ? "Message GOAT Bot" : "GOAT Bot isn't available"}
        onSend={onSend}
      />
    </div>
  );
}

function statusLine(availability: GoatBotAvailability): string {
  switch (availability.kind) {
    case "ready":
      return "Answers here, works in its own threads";
    case "connecting":
      return "Connecting…";
    case "offline":
      return "Offline";
    case "legacy_active":
      return "Waiting for the global agent";
    case "error":
      return "Couldn't connect";
    case "unsupported":
      return "Not available on this server";
  }
}

function GoatBotNotice({
  availability,
  onRetryAvailability,
  legacyAgentRoute,
}: {
  readonly availability: GoatBotAvailability;
  readonly onRetryAvailability: (() => void) | undefined;
  readonly legacyAgentRoute: GlobalAgentLegacyRoute | null;
}) {
  const { title, description, retryLabel } = noticeCopy(availability);
  const actions: ReactNode[] = [];
  if (retryLabel !== null && onRetryAvailability !== undefined) {
    actions.push(
      <Button key="retry" size="sm" variant="outline" onClick={onRetryAvailability}>
        {retryLabel}
      </Button>,
    );
  }
  if (legacyAgentRoute !== null && availability.kind !== "ready") {
    actions.push(
      <Button
        key="legacy"
        size="sm"
        variant="outline"
        render={
          legacyAgentRoute.kind === "thread" ? (
            <Link
              to="/$environmentId/$threadId"
              params={{
                environmentId: legacyAgentRoute.environmentId,
                threadId: legacyAgentRoute.threadId,
              }}
            />
          ) : (
            <Link to="/draft/$draftId" params={{ draftId: legacyAgentRoute.draftId }} />
          )
        }
      >
        Open global agent
      </Button>,
    );
  }
  return (
    <Empty className="min-h-0 flex-1">
      <EmptyHeader className="max-w-md">
        <GoatBotAvatar size="lg" className="mx-auto mb-4" />
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {actions.length > 0 ? (
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">{actions}</div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function noticeCopy(availability: GoatBotAvailability): {
  title: string;
  description: string;
  retryLabel: string | null;
} {
  switch (availability.kind) {
    case "ready":
      return {
        title: "Ask GOAT Bot for anything",
        description: "It answers here and starts the work in its own threads.",
        retryLabel: null,
      };
    case "connecting":
      return {
        title: "Connecting to GOAT Bot…",
        description: "This takes a moment.",
        retryLabel: null,
      };
    case "offline":
      return {
        title: "GOAT Bot's computer is offline",
        description: "You can send messages again once it reconnects.",
        retryLabel: null,
      };
    case "legacy_active":
      return {
        title: "Your global agent is still working",
        description: "GOAT Bot takes over once it finishes. Its history stays in the global agent.",
        retryLabel: "Check again",
      };
    case "error":
      return {
        title: "Couldn't reach GOAT Bot",
        description: availability.message,
        retryLabel: "Try again",
      };
    case "unsupported":
      return {
        title: "GOAT Bot isn't available here yet",
        description: `This server doesn't support GOAT Bot. Update ${APP_DISPLAY_NAME} on the server to chat with it.`,
        retryLabel: null,
      };
  }
}
