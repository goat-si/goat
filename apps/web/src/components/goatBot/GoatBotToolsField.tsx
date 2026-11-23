import type { BotProfile } from "@goat/contracts";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

type Tools = NonNullable<BotProfile["tools"]>;

export function GoatBotToolsField({
  value,
  importedNames,
  onChange,
}: {
  readonly value: Tools;
  readonly importedNames?: BotProfile["importedToolNames"];
  readonly onChange: (value: Tools) => void;
}) {
  return (
    <fieldset className="grid gap-3">
      <legend className="font-medium">Tools</legend>
      <p className="text-sm text-muted-foreground">
        Restricting tools stops active work. For now, a bot with tool limits can't start work. Allow
        all MCP servers and all skills to run it again.
      </p>
      {(["mcpServers", "skills"] as const).map((key) => (
        <ToolAllowlist
          key={key}
          label={key === "mcpServers" ? "MCP servers" : "skills"}
          value={value[key]}
          importedNames={importedNames?.[key]}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
    </fieldset>
  );
}

function ToolAllowlist({
  label,
  value,
  importedNames,
  onChange,
}: {
  readonly label: string;
  readonly importedNames?: readonly string[] | undefined;
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
      {importedNames !== undefined && importedNames.length > 0 && (
        <div className="grid gap-1 text-sm text-muted-foreground">
          <p>Imported {label}. Enter the matching local identifiers below to grant access.</p>
          <ul className="max-h-20 list-disc overflow-auto ps-5">
            {[...new Set(importedNames)].map((name) => (
              <li key={name} className="break-all">
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {value !== "all" ? (
        <Textarea
          aria-label={`Allowed ${label}`}
          placeholder="Enter one name per line"
          defaultValue={value.join("\n")}
          onChange={(event) => {
            const names = event.target.value
              .split("\n")
              .map((name) => name.trim())
              .filter(Boolean);
            onChange([...new Set(names)]);
          }}
        />
      ) : null}
    </div>
  );
}
