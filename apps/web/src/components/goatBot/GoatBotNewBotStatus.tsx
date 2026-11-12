import type { NewBotOperation } from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import { Link } from "@tanstack/react-router";

import { XIcon } from "~/components/solar";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

/**
 * The roster's lines for New bot: Creating… until the server answers, the reason with Retry and
 * Dismiss when it failed, and each created bot until the list holds its own row.
 */
export function GoatBotNewBotStatus(props: {
  readonly operation: NewBotOperation | null;
  /** Created bots the roster's list does not hold yet. */
  readonly created: ReadonlyArray<BotProfile>;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly onDismissCreated: (bot: BotProfile) => void;
}) {
  const { operation } = props;
  return (
    <>
      {props.created.length > 0 ? (
        <SidebarMenu>
          {props.created.map((bot) => (
            <SidebarMenuItem key={bot.botId}>
              <SidebarMenuButton
                size="lg"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId: bot.environmentId, threadId: bot.sessionThreadId }}
                  />
                }
              >
                <Initial name={bot.name} />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                <span aria-hidden className="w-5 shrink-0" />
              </SidebarMenuButton>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Dismiss ${bot.name}`}
                className="absolute top-1/2 right-1 -translate-y-1/2"
                onClick={() => props.onDismissCreated(bot)}
              >
                <XIcon />
              </Button>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      ) : null}
      {operation?.phase === "creating" ? (
        <div
          role="status"
          className="mb-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-sidebar-muted-foreground"
        >
          <Initial name={operation.name} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sidebar-foreground">{operation.name}</span>
            <span className="text-xs">Creating…</span>
          </span>
        </div>
      ) : null}
      {operation?.phase === "failed" ? (
        <div className="mb-1 grid gap-1.5 px-2 py-1">
          <p role="alert" className="text-xs text-destructive-foreground">
            Couldn't create {operation.name}: {operation.failure}
          </p>
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="outline"
              aria-label={`Retry creating ${operation.name}`}
              onClick={props.onRetry}
            >
              Retry
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Dismiss creating ${operation.name}`}
              onClick={props.onDismiss}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Initial({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-goat-avatar-border bg-goat-avatar text-goat-avatar-foreground"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
