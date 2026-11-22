import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  BotId,
  type ChannelListFollowedThreadsResult,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useQuietThreadShell } from "~/state/entities";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { useGoatBotMember } from "./goatBotMemberContext";

export function GoatBotFollowedThreads({
  environmentId,
  rows,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly onRefresh: () => void;
  readonly rows: ChannelListFollowedThreadsResult["followedThreads"];
}) {
  const botId = useGoatBotMember()?.botId ?? BotId.make("main");
  const canStop = useAtomValue(
    channelEnvironment.stopFollowingThread.permissionAtom(environmentId),
  );
  const stop = useAtomCommand(channelEnvironment.stopFollowingThread);
  return (
    <section className="space-y-2 border-b border-border px-3 py-3">
      <h3 className="font-medium">Followed threads</h3>
      {rows.map((row) => (
        <div key={row.threadId} className="flex flex-wrap items-center gap-2 text-sm">
          <FollowedThreadLink target={scopeThreadRef(row.environmentId, row.threadId)} />
          <span className="text-muted-foreground">{row.status}</span>
          {row.pullRequest && (
            <span className="break-all text-muted-foreground">{row.pullRequest}</span>
          )}
          {canStop && (
            <Button
              size="xs"
              variant="outline"
              onClick={async () => {
                const result = await stop({
                  environmentId,
                  input: { botId, environmentId: row.environmentId, threadId: row.threadId },
                });
                if (result._tag === "Success") onRefresh();
              }}
            >
              Stop following
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}

function FollowedThreadLink({ target }: { readonly target: ScopedThreadRef }) {
  const thread = useQuietThreadShell(target);
  return (
    <Link
      className="font-medium hover:underline"
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(target)}
    >
      {thread?.title ?? "Open followed thread"}
    </Link>
  );
}
