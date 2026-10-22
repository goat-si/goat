import type { CloudFolderTrust } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import type { FleetFolderTrustSource } from "../../state/fleet";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** One sentence a person can act on; GOAT answers the prompt itself either way. */
export function folderTrustLabel(folder: CloudFolderTrust): string {
  if (folder.trusted === true)
    return folder.acceptedByGoatAt === null
      ? "Claude Code trusts this folder"
      : `Claude Code trusts this folder · accepted automatically by GOAT on ${dateLabel(folder.acceptedByGoatAt)}`;
  if (folder.trusted === false)
    return "Not trusted yet · GOAT accepts it automatically on the next launch";
  return "Trust unknown · GOAT accepts it automatically if Claude Code asks";
}

/** Claude Code's per-folder trust for each project, under the cloud agents it gates. */
export function FleetCloudFolderTrust({
  sources,
}: {
  readonly sources: ReadonlyArray<FleetFolderTrustSource>;
}) {
  if (sources.length === 0) return null;
  const showEnvironment = sources.length > 1;
  return (
    <section aria-label="Claude Code folder trust" className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">Claude Code folder trust</h3>
      <ul className="flex flex-col">
        {sources.flatMap((source) =>
          source.folders.map((folder) => (
            <li key={`${source.environmentId}:${folder.instanceId}:${folder.projectId}`}>
              <FolderTrustRow
                environmentId={source.environmentId}
                environmentLabel={showEnvironment ? source.label : null}
                folder={folder}
              />
            </li>
          )),
        )}
      </ul>
    </section>
  );
}

function FolderTrustRow(props: {
  readonly environmentId: FleetFolderTrustSource["environmentId"];
  readonly environmentLabel: string | null;
  readonly folder: CloudFolderTrust;
}) {
  const accept = useAtomCommand(serverEnvironment.acceptCloudFolderTrust, "Trust folder");
  const allowed = useAtomValue(
    serverEnvironment.acceptCloudFolderTrust.permissionAtom(props.environmentId),
  );
  const [busy, setBusy] = useState(false);
  const { folder } = props;
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
      <span className="min-w-0 truncate font-medium">{folder.title}</span>
      <span className="hidden min-w-0 max-w-[35%] truncate text-xs text-muted-foreground sm:inline">
        {props.environmentLabel === null
          ? folder.path
          : `${props.environmentLabel} · ${folder.path}`}
      </span>
      <span className="ml-auto min-w-0 truncate text-right text-xs text-muted-foreground">
        {folderTrustLabel(folder)}
      </span>
      {folder.trusted === true ? null : (
        <Button
          size="compact"
          variant="outline"
          disabled={!allowed || busy}
          onClick={() => {
            setBusy(true);
            void accept({
              environmentId: props.environmentId,
              input: { instanceId: folder.instanceId, projectId: folder.projectId },
            }).finally(() => setBusy(false));
          }}
        >
          {busy ? "Trusting…" : "Trust now"}
        </Button>
      )}
    </div>
  );
}
