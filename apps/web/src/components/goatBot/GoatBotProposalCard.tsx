import { useAtomValue } from "@effect/atom-react";
import type { BotProposalCard, EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

export function GoatBotProposalCard({
  card,
  environmentId,
}: {
  readonly card: BotProposalCard;
  readonly environmentId: EnvironmentId;
}) {
  const environment = useEnvironment(environmentId);
  const permitted = useAtomValue(
    channelEnvironment.resolveBotProposal.permissionAtom(environmentId),
  );
  const resolve = useAtomCommand(channelEnvironment.resolveBotProposal);
  const [saving, setSaving] = useState(false);
  const [settled, setSettled] = useState<"accepted" | "dismissed">();
  const [now] = useState(Date.now);
  const expired = Date.parse(card.expiresAt) <= now;
  const status = settled ?? card.status;
  const canResolve =
    permitted && environment?.serverConfig?.environment.capabilities.goatBotProposals === true;
  async function submit(accept: boolean) {
    setSaving(true);
    const result = await resolve({
      environmentId,
      input: { proposalId: card.proposalId, accept },
    }).finally(() => setSaving(false));
    if (result._tag === "Success") setSettled(accept ? "accepted" : "dismissed");
  }
  return (
    <section
      aria-label="Bot proposal"
      className="mx-auto max-w-xl space-y-3 rounded-lg border border-border bg-card p-4 text-sm text-card-foreground"
    >
      <h3 className="font-medium">
        {card.fields.avatar} {card.fields.name}
      </h3>
      {card.fields.purpose && (
        <p className="whitespace-pre-wrap break-words">{card.fields.purpose}</p>
      )}
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{card.fields.why}</p>
      {card.fields.instructions && (
        <div>
          <h4 className="font-medium">Instructions</h4>
          <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
            {card.fields.instructions}
          </p>
        </div>
      )}
      {status === "pending" && !expired && canResolve ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={saving} onClick={() => void submit(true)}>
            Accept
          </Button>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => void submit(false)}>
            Dismiss
          </Button>
        </div>
      ) : (
        <p role="status" className="text-muted-foreground">
          {status === "accepted"
            ? "Accepted"
            : status === "dismissed"
              ? "Dismissed"
              : expired
                ? "Expired"
                : "Awaiting review"}
        </p>
      )}
    </section>
  );
}
