import {
  botTaskActivityFallbackName,
  botTaskActivityFallbackNames,
  botTaskActivityText,
  botTaskActivityWorkerRef,
} from "@goat/client-runtime/goatBot";
import type { BotWorkResult, ChannelBotTaskActivityEntry } from "@goat/contracts";
import { useThreadShell } from "~/state/entities";

function TaskActivityRow({
  entry,
  workers,
  fallbackName,
}: {
  readonly entry: ChannelBotTaskActivityEntry;
  readonly workers: BotWorkResult["codingRows"];
  readonly fallbackName: string | undefined;
}) {
  const thread = useThreadShell(botTaskActivityWorkerRef(entry));
  return (
    <li className="break-words">
      <p>{botTaskActivityText(entry, workers, thread?.title, fallbackName)}</p>
      <p>
        <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
        {" · "}
        {entry.actor === "goat" ? "GOAT" : entry.actor === "bot" ? "Bot" : "Person"}
      </p>
    </li>
  );
}

export function GoatBotTaskActivity({ work }: { readonly work: BotWorkResult }) {
  const activity = work.activity;
  if (activity === undefined || (activity.entries.length === 0 && !activity.incompleteBefore))
    return null;
  const fallbackNames = botTaskActivityFallbackNames(activity.entries);
  return (
    <details className="px-3 py-1 text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer font-medium text-foreground">Activity</summary>
      <ol className="max-h-48 space-y-2 overflow-y-auto py-2">
        {activity.entries.map((entry) => (
          <TaskActivityRow
            key={entry.id}
            entry={entry}
            workers={work.codingRows}
            fallbackName={botTaskActivityFallbackName(entry, fallbackNames)}
          />
        ))}
      </ol>
      {activity.incompleteBefore && (
        <p>
          Activity before {new Date(activity.incompleteBefore).toLocaleDateString()} may be
          incomplete.
        </p>
      )}
    </details>
  );
}
