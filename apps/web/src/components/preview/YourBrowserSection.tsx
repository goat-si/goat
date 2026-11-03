import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@goat/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export function YourBrowserSection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = threadRef;
  const result = useEnvironmentQuery(previewEnvironment.claimChanges({ environmentId, input: {} }));
  const canEnd = useAtomValue(previewEnvironment.claimEnd.permissionAtom(environmentId));
  const canRevoke = useAtomValue(previewEnvironment.claimRevoke.permissionAtom(environmentId));
  const end = useAtomCommand(previewEnvironment.claimEnd, "end browser claim");
  const revoke = useAtomCommand(previewEnvironment.claimRevoke, "revoke browser grant");
  if (!result.isSuccess || !result.data) return null;
  const claims = result.data.claims.filter((claim) => claim.threadId === threadId);
  const grants = result.data.grants.filter((grant) => grant.threadId === threadId);
  const pending = result.data.pending.filter((request) => request.threadId === threadId);
  if (!claims.length && !grants.length && !pending.length) return null;
  return (
    <section
      aria-label="Your browser"
      className="flex max-h-48 shrink-0 flex-col gap-2 overflow-auto border-b p-3 text-sm"
    >
      <h2 className="font-medium">Your browser</h2>
      {claims.map((claim) => (
        <div key={claim.claimId} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate">{claim.windowTitle ?? claim.title}</div>
            <div className="truncate text-muted-foreground">{claim.origin}</div>
          </div>
          <Badge variant="secondary">Agent attached</Badge>
          <Button
            size="xs"
            variant="outline"
            disabled={!canEnd}
            onClick={() => void end({ environmentId, input: { claimId: claim.claimId } })}
          >
            End
          </Button>
        </div>
      ))}
      {grants.map((grant) => (
        <div key={grant.origin} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{grant.origin}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={!canRevoke}
            onClick={() =>
              void revoke({ environmentId, input: { threadId, origin: grant.origin } })
            }
          >
            Revoke
          </Button>
        </div>
      ))}
      {pending.map((request) => (
        <p key={request.claimId} className="text-muted-foreground">
          {request.windowTitle} · {request.origin}. See the thread's approval card.
        </p>
      ))}
    </section>
  );
}
