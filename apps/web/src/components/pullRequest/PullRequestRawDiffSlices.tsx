import { cn } from "~/lib/utils";
import type { RenderablePatch } from "~/lib/diffRendering";

export function PullRequestRawDiffSlices({
  slices,
  separated,
}: {
  readonly slices: readonly Extract<RenderablePatch, { kind: "raw" }>[];
  readonly separated?: boolean;
}) {
  return (
    <div className={cn("space-y-4 px-4 py-5", separated && "border-t border-border/60")}>
      {slices.map((slice) => (
        <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
          <p className="text-xs text-muted-foreground">{slice.reason}</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
        </div>
      ))}
    </div>
  );
}
