import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffFileStatus } from "./DiffFileStatus";

export function DiffFileHeaderSuffix({
  filePath,
  hasStat,
  error,
  truncated,
  unknownChangeType,
  onRetry,
}: {
  filePath: string;
  hasStat: boolean;
  error: boolean;
  truncated?: boolean;
  unknownChangeType?: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      {unknownChangeType ? <span>Unknown change type</span> : null}
      <span data-diff-copy-path className="inline-flex">
        <DiffFilePathCopyButton filePath={filePath} />
      </span>
      {hasStat ? (
        <DiffFileStatus error={error} truncated={truncated} retry={() => onRetry(filePath)} />
      ) : null}
    </>
  );
}
