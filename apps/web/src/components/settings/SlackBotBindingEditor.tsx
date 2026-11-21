import {
  type BotId,
  type BotProfile,
  type SlackBotBindings,
  SLACK_BOT_BINDING_LIMIT,
} from "@goat/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { parseSlackChannelIds } from "./SlackChannelSettings.logic";

export function SlackBotBindingEditor(props: {
  readonly bindings: SlackBotBindings;
  readonly bots: ReadonlyArray<BotProfile>;
  readonly disabled: boolean;
  readonly onChange: (bindings: SlackBotBindings) => void;
}) {
  const { bindings, bots, disabled, onChange } = props;
  const [channel, setChannel] = useState("");
  const [target, setTarget] = useState<BotId | null>(null);
  const parsed = parseSlackChannelIds(channel);
  const channelId =
    parsed.invalid.length === 0 && parsed.ids.length === 1 ? parsed.ids[0] : undefined;
  const atLimit = bindings.length >= SLACK_BOT_BINDING_LIMIT;
  const alreadyAssigned = bindings.some((binding) => binding.channelId === channelId);
  const canAdd = channelId !== undefined && target !== null && !alreadyAssigned && !atLimit;

  return (
    <SettingsRow
      title="Channel bindings"
      description="Choose which bot answers new threads in a Slack channel."
    >
      <div className="flex flex-col gap-2">
        {bindings.map((binding) => (
          <div key={binding.channelId} className="flex flex-wrap items-center gap-2">
            <span className="mr-auto truncate font-mono text-xs">{binding.channelId}</span>
            <BotPicker
              bots={bots}
              value={binding.botId}
              label={"Bot for " + binding.channelId}
              disabled={disabled}
              onChange={(botId) =>
                onChange(
                  bindings.map((row) =>
                    row.channelId === binding.channelId ? { ...row, botId } : row,
                  ),
                )
              }
            />
            <Button
              variant="outline"
              size="sm"
              aria-label={"Unbind " + binding.channelId}
              disabled={disabled}
              onClick={() =>
                onChange(bindings.filter((row) => row.channelId !== binding.channelId))
              }
            >
              Unbind
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-36 flex-1">
            <Input
              size="sm"
              aria-label="Slack channel ID to bind"
              placeholder="C0123456789"
              value={channel}
              maxLength={32}
              disabled={disabled || atLimit}
              onChange={(event) => setChannel(event.target.value)}
            />
          </div>
          <BotPicker
            bots={bots}
            value={target}
            label="Bot for new Slack channel"
            disabled={disabled || atLimit}
            onChange={setTarget}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !canAdd}
            onClick={() => {
              if (channelId === undefined || target === null) return;
              onChange([...bindings, { channelId, botId: target }]);
              setChannel("");
              setTarget(null);
            }}
          >
            Add binding
          </Button>
        </div>
        {alreadyAssigned ? (
          <p className="text-xs text-muted-foreground">This channel already has a binding.</p>
        ) : null}
        {atLimit ? (
          <p className="text-xs text-muted-foreground">All 100 bindings are in use.</p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function BotPicker(props: {
  readonly bots: ReadonlyArray<BotProfile>;
  readonly value: BotId | null;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (botId: BotId) => void;
}) {
  const { bots, value, label, disabled, onChange } = props;
  const selected = bots.find((bot) => bot.botId === value);
  return (
    <Select
      disabled={disabled || bots.length === 0}
      value={value}
      onValueChange={(botId) => {
        const bot = bots.find((option) => option.botId === botId);
        if (bot !== undefined) onChange(bot.botId);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>
          {selected?.name ?? (value === null ? "Choose bot" : "Unavailable bot")}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {bots.map((bot) => (
          <SelectItem key={bot.botId} value={bot.botId}>
            {bot.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
