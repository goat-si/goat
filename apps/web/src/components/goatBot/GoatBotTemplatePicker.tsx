import { useAtomValue } from "@effect/atom-react";
import { botManageFailure, offerBotTemplateDraft } from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { GOAT_BOT_TEMPLATES } from "@goat/shared/goatBotNames";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
import { openNewBotChat } from "./goatBotNewBotOpen";

import { useGoatBotTemplateSupport } from "./useGoatBotTemplateSupport";

type Template = (typeof GOAT_BOT_TEMPLATES)[number];

export function GoatBotTemplatePicker({
  environmentId,
  close,
}: {
  environmentId: EnvironmentId;
  close: () => void;
}) {
  const router = useRouter();
  const allowed = useGoatBotTemplateSupport(environmentId);
  const mayCreate = useAtomValue(channelEnvironment.createBot.permissionAtom(environmentId));
  const send = useAtomCommand(channelEnvironment.createBot, { reportFailure: false });
  const [template, select] = useState<Template>(GOAT_BOT_TEMPLATES[0]);
  const [name, setName] = useState<string>(GOAT_BOT_TEMPLATES[0].name);
  const [request, setRequest] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<BotProfile>();

  const open = (bot: BotProfile) => {
    offerBotTemplateDraft(bot, template.firstMessage);
    close();
    openNewBotChat(router, bot);
  };

  const create = async () => {
    if (!allowed || !mayCreate || busy || !name.trim()) return;
    const clientRequestId = request ?? randomUUID();
    setRequest(clientRequestId);
    setBusy(true);
    setError(undefined);
    const result = await send({
      environmentId,
      input: {
        templateId: template.id,
        clientRequestId,
        name: name.trim(),
        avatar: template.face,
        purpose: template.purpose,
        defaultModelSelection: null,
      },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      setError(botManageFailure(squashAtomCommandFailure(result)));
      return;
    }
    if (result.value.templateAutomationPending) {
      setCreated(result.value.bot);
      setError("1 routine could not be added");
      return;
    }
    open(result.value.bot);
  };

  return (
    <Dialog
      open={allowed}
      onOpenChange={(value) => {
        if (!value && !busy) close();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>From a template</DialogTitle>
          <DialogDescription>Choose a starter for your bot.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset className="grid grid-cols-2 gap-1.5">
            <legend className="mb-2 text-sm font-medium">Template</legend>
            {GOAT_BOT_TEMPLATES.map((item) => (
              <label
                key={item.id}
                className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
              >
                <input
                  type="radio"
                  name="goat-bot-template"
                  checked={template.id === item.id}
                  disabled={request !== undefined}
                  onChange={() => {
                    select(item);
                    setName(item.name);
                  }}
                />
                <span aria-hidden>{item.face}</span>
                {item.name}
              </label>
            ))}
          </fieldset>
          <label className="grid gap-1.5 text-sm">
            Name
            <Input
              value={name}
              maxLength={64}
              disabled={request !== undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="grid gap-2 text-sm">
            <p>{template.purpose}</p>
            <p>
              <strong>Instructions</strong> {template.instructions}
            </p>
            <p>
              <strong>Paused</strong> · {template.automation.title}
            </p>
            <details>
              <summary>Automation prompt</summary>
              {template.automation.prompt}
            </details>
            <p>
              <strong>First message draft</strong> {template.firstMessage}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => (created ? open(created) : close())}
          >
            {created ? "Open bot" : "Cancel"}
          </Button>
          <Button disabled={!mayCreate || busy || !name.trim()} onClick={() => void create()}>
            {busy ? "Creating…" : error ? "Retry" : "Create bot"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
