import type { BotProfile } from "@goat/contracts";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

type Tools = NonNullable<BotProfile["tools"]>;

export function GoatBotToolsField({
  value,
  onChange,
}: {
  readonly value: Tools;
  readonly onChange: (value: Tools) => void;
}) {
  return (
    <fieldset className="grid gap-3">
      <legend className="font-medium">Tools</legend>
      <p className="text-sm text-muted-foreground">
        Restricting tools stops active work. The bot can start again when its destination supports
        the limits or you allow all tools.
      </p>
      {(["mcpServers", "skills"] as const).map((key) => (
        <ToolAllowlist
          key={key}
          label={key === "mcpServers" ? "MCP servers" : "skills"}
          value={value[key]}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
    </fieldset>
  );
}

function ToolAllowlist({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: Tools["skills"];
  readonly onChange: (value: Tools["skills"]) => void;
}) {
  return (
    <div className="grid gap-2">
      <label className="flex items-center justify-between gap-2 text-sm">
        Allow all {label}
        <Switch
          checked={value === "all"}
          onCheckedChange={(checked) => onChange(checked ? "all" : [])}
        />
      </label>
      {value !== "all" ? (
        <Textarea
          aria-label={`Allowed ${label}`}
          placeholder="Enter one name per line"
          defaultValue={value.join("\n")}
          onChange={(event) =>
            onChange(
              event.target.value
                .split("\n")
                .map((name) => name.trim())
                .filter(Boolean),
            )
          }
        />
      ) : null}
    </div>
  );
}
