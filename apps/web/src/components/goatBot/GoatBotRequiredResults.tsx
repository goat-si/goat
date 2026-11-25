import type { RequiredResults } from "@goat/client-runtime/goatBot";
import { useGT } from "gt-react";

export function GoatBotRequiredResults({ progress }: { progress: RequiredResults }) {
  const gt = useGT();
  const labels = {
    pending: gt("Not started"),
    running: gt("In progress"),
    awaiting_acceptance: gt("Awaiting acceptance"),
    accepted: gt("Accepted"),
    failed: gt("Failed"),
  };
  return (
    <section className="min-h-0 max-h-52 overflow-y-auto border-b border-border px-3 py-2 text-sm">
      <h3 className="flex items-baseline justify-between gap-2 font-medium">
        {gt("Required results accepted")}
        <span className="tabular-nums">
          {progress.accepted}/{progress.items.length}
        </span>
      </h3>
      <ul className="mt-1 divide-y divide-border">
        {progress.items.map((item) => (
          <li key={item.id} className="py-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="min-w-0 break-words">{item.criterion}</span>
              <span className="text-xs text-muted-foreground">{labels[item.state]}</span>
            </div>
            {item.host && (
              <p className="break-all text-xs text-muted-foreground">
                {gt("Worker on {host}", { host: item.host })}
              </p>
            )}
            {item.attempt > 1 && (
              <span className="text-xs text-muted-foreground">
                {gt("Attempt {attempt}", { attempt: item.attempt })}
              </span>
            )}
            {item.evidence && (
              <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {item.evidence}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
