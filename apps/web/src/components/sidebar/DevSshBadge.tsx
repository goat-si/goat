import { useAtomValue } from "@effect/atom-react";

import { primaryServerConfigAtom } from "../../state/server";
import { Badge } from "../ui/badge";

/** The primary environment is a dev server started with GOAT_DEV_SSH=on; it can reach real machines. */
export function DevSshBadge() {
  const devSsh = useAtomValue(primaryServerConfigAtom)?.environment.devSsh;
  if (devSsh !== "on") return null;
  return (
    <div className="ml-1 flex h-7 items-center">
      <Badge
        variant="warning"
        size="sm"
        title="GOAT_DEV_SSH=on: this app's dev server may SSH into your other machines."
      >
        SSH on
      </Badge>
    </div>
  );
}
