import { useGT } from "gt-react";
import { ChevronsLeftRightEllipsisIcon } from "~/components/solar";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";

export function EmptyRemoteEnvironments({
  cloudEnabled = true,
}: {
  readonly cloudEnabled?: boolean;
}) {
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
