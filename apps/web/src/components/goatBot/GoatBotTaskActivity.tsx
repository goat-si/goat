import { botTaskActivityText } from "@goat/client-runtime/goatBot";
import type { BotWorkResult } from "@goat/contracts";

export function GoatBotTaskActivity({ work }: { readonly work: BotWorkResult }) {
  const activity = work.activity;
  if (activity === undefined || (activity.entries.length === 0 && !activity.incompleteBefore))
    return null;
  const titleOf = new Map(work.codingRows.map((row) => [row.threadId, row.title]));
  return (
    <details className="px-3 py-1 text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer font-medium text-foreground">Activity</summary>
      <ol className="max-h-48 space-y-2 overflow-y-auto py-2">
        {activity.entries.map((entry) => (
          <li key={entry.id} className="break-words">
            <p>
              {botTaskActivityText(
                entry,
                "threadId" in entry ? titleOf.get(entry.threadId) : undefined,
              )}
            </p>
            <p>
              <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
              {" · "}
              {entry.actor === "goat" ? "GOAT" : entry.actor === "bot" ? "Bot" : "Person"}
            </p>
          </li>
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
