import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffFileStatus } from "./DiffFileStatus";

export function DiffFileHeaderSuffix({
  filePath,
  hasStat,
  error,
  truncated,
  onRetry,
}: {
  filePath: string;
  hasStat: boolean;
  error: boolean;
  truncated: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      <span data-diff-copy-path className="inline-flex">
        <DiffFilePathCopyButton filePath={filePath} />
      </span>
      {hasStat ? (
        <DiffFileStatus error={error} truncated={truncated} retry={() => onRetry(filePath)} />
      ) : null}
    </>
  );
}
