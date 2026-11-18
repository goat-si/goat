import { Button } from "../ui/button";

export function PullRequestWithheldFileNotice({
  status,
  readable,
  load,
}: {
  readonly status: "idle" | "loading" | "error" | "empty";
  readonly readable: boolean;
  readonly load: () => void;
}) {
  const message =
    status === "loading"
      ? "Loading diff…"
      : status === "error"
        ? "This file’s diff could not be loaded."
        : status === "empty"
          ? "No text diff is available for this file."
          : "This file’s diff is too large to display.";
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
      <span role="status">{message}</span>
      {readable && (status === "idle" || status === "error") ? (
        <Button size="xs" variant="outline" onClick={load}>
          {status === "error" ? "Retry" : "Load file diff"}
        </Button>
      ) : null}
    </div>
  );
}
