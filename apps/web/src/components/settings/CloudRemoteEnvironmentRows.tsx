import { useGT } from "gt-react";
import { ChevronsLeftRightEllipsisIcon } from "~/components/solar";
import type { EnvironmentId } from "@goat/contracts";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import type { EnvironmentPresentation } from "~/state/environments";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  const gt = useGT();
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{gt("No saved remote environments")}</EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? gt(
                "Click “Add device” to pair another environment, or connect one from GOAT Connect.",
              )
            : gt("Click “Add device” to pair another environment.")}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
  hasPendingAdds,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly hasPendingAdds: boolean;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={hasPendingAdds ? null : <EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 && !hasPendingAdds ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}
