import { useGT } from "gt-react";

export function SkippedImportDetails({
  skipped,
  omitted,
}: {
  skipped: Array<{ project: string; thread: string; reason: string }>;
  omitted: number;
}) {
  const gt = useGT();
  return (
    <div className="max-h-52 overflow-y-auto whitespace-pre-line break-words">
      {skipped
        .map(({ project, thread, reason }) => `${project} · ${thread}: ${gt(reason)}`)
        .join("\n\n")}
      {omitted > 0 && `\n\n${gt("And {count} more", { count: omitted })}`}
    </div>
  );
}
