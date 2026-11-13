import {
  botArtifactName,
  botArtifactSizeLabel,
  botArtifactsFailure,
  goatBotArtifactDays,
} from "@goat/client-runtime/goatBot";
import type { ChannelBotArtifact, EnvironmentId } from "@goat/contracts";
import { useEffect, useState } from "react";

import { FileIcon, FileTextIcon, ImageIcon } from "~/components/solar";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { GroupedCard } from "../ui/grouped-card";
import { useGoatBotName } from "./goatBotMemberContext";
import { GoatBotPanelEmpty } from "./GoatBotPanelEmpty";

function FileKindIcon({ relativePath }: { readonly relativePath: string }) {
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(relativePath))
    return <ImageIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  if (/\.(md|markdown|txt|csv|json|log)$/i.test(relativePath))
    return <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

/** Files GOAT Bot's workers saved, by day; a file opens in place of the conversation. */
export function GoatBotLibrary({
  environmentId,
  openPath = null,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  /** The file open in the chat, marked in the list. */
  readonly openPath?: string | null;
  readonly onOpen: (file: ChannelBotArtifact) => void;
}) {
  const botName = useGoatBotName();
  const offline = useEnvironment(environmentId)?.connection.phase === "offline";
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.goatBotLibrary === true;
  const files = useEnvironmentQuery(
    supported ? channelEnvironment.listBotArtifacts({ environmentId, input: {} }) : null,
  );
  const refresh = files.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Workers save files on the server at any time; read the folder again each time the tab opens.
  useEffect(() => {
    if (supported) refresh();
  }, [supported, refresh]);
  const [nowMs] = useState(() => Date.now());
  if (offline) return <p>Files are unavailable while {botName}'s computer is offline.</p>;
  if (!supported) return <p>Files need a newer GOAT server.</p>;
  const failure = files.failure === null ? null : botArtifactsFailure(files.failure, botName);
  if (failure !== null)
    return (
      <div className="space-y-2">
        <p>{failure.message}</p>
        {failure.retry && (
          <Button size="xs" variant="outline" onClick={refresh}>
            Try again
          </Button>
        )}
      </div>
    );
  if (files.data === null) return <p className="text-muted-foreground">Loading files…</p>;
  if (files.data.artifacts.length === 0)
    return (
      <GoatBotPanelEmpty title="No files yet" next={`Files ${botName} saves will appear here.`} />
    );
  return (
    <div className="space-y-5">
      {files.data.truncated && (
        <p className="text-xs text-muted-foreground">Showing the newest files only.</p>
      )}
      {goatBotArtifactDays(files.data.artifacts, nowMs).map((day) => (
        <section key={day.key} aria-label={day.label} className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{day.label}</h3>
          <GroupedCard radius="lg" divided={false} className="overflow-hidden">
            <ul className="divide-y divide-border/50">
              {day.files.map((file) => {
                const name = botArtifactName(file.relativePath);
                const folder = file.relativePath.slice(0, -name.length).replace(/\/$/, "");
                const open = file.relativePath === openPath;
                return (
                  <li key={file.relativePath}>
                    <button
                      type="button"
                      aria-current={open ? "true" : undefined}
                      onClick={() => onOpen(file)}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=true]:bg-accent"
                    >
                      <FileKindIcon relativePath={file.relativePath} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[folder, botArtifactSizeLabel(file.size)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </GroupedCard>
        </section>
      ))}
    </div>
  );
}
