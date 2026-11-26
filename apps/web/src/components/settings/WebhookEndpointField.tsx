import { useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { webhookAddress } from "@goat/client-runtime/webhook-address";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, ScheduledTask } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { usePrimaryCloudLinkState } from "~/cloud/primaryCloudLinkState";
import { CopyIcon } from "~/components/solar";
import { requestConfirmDialog } from "~/confirmDialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function WebhookEndpointField({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: Pick<ScheduledTask, "id" | "webhook"> | null;
}) {
  const gt = useGT();
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "webhook URL" });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">{gt("The URL appears after you save.")}</p>;
  }
  const {
    address: url,
    copyable,
    note,
  } = webhookAddress(endpoint, httpBaseUrl, {
    connect: gt("Link GOAT Connect for a public URL."),
    linkEnvironment: gt("Link this environment to GOAT Connect for a public URL."),
    comingSoon: (name) => gt("Public URLs arrive with {name} (coming soon).", { name }),
    local: (hint) => gt("Only this computer can call this address. {hint}", { hint }),
    reachable: (hint) =>
      gt(
        "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. {hint}",
        { hint },
      ),
  });
  const rotateUrl = async () => {
    const question = gt("Rotate this webhook URL? The current URL stops working.");
    const confirmed =
      (await requestConfirmDialog(question, {
        variant: "destructive",
      })) ?? window.confirm(question);
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not rotate webhook URL"),
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label={gt("Webhook URL")}
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? gt("Copied") : gt("Copy")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          {gt("Rotate")}
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? gt("Held for up to 24 hours while this environment is offline.")
        : gt("Forwarded live. Requests fail while this environment is offline.")}{" "}
      <Link to="/settings/connections" className="underline underline-offset-2">
        {gt("Change in Connections")}
      </Link>
    </p>
  );
}
