import { ProviderInstanceId, TextGeneratorConfig, type ServerSettingsPatch } from "@goat/contracts";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import * as Schema from "effect/Schema";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const validConfig = Schema.is(TextGeneratorConfig);

export function TextGeneratorSettings(props: {
  readonly generators: Readonly<Record<string, TextGeneratorConfig>>;
  readonly canManage: boolean;
  readonly canSelect: boolean;
  readonly onPatch: (patch: ServerSettingsPatch) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<"openaiCompatible" | "anthropic">("openaiCompatible");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState<ProviderInstanceId | null>(null);
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const previous = editing === null ? undefined : props.generators[editing];
  const config = {
    kind,
    ...(label.trim() ? { label: label.trim() } : {}),
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    apiKey: clearKey ? "" : apiKey || previous?.apiKey || "",
    enabled: previous?.enabled ?? true,
  };
  const valid = model.trim().length > 0 && validConfig(config);
  const save = () => {
    if (!valid || busy || !props.canManage) return;
    const id = editing ?? ProviderInstanceId.make(`text-api-${randomUUID()}`);
    setBusy(true);
    // A promise chain, since React Compiler cannot compile try/finally without catch.
    return props
      .onPatch({ textGenerators: { [id]: config } })
      .then((saved) => {
        if (!saved) return;
        setLabel("");
        setBaseUrl("");
        setModel("");
        setApiKey("");
        setEditing(null);
        setClearKey(false);
      })
      .finally(() => setBusy(false));
  };
  return (
    <SettingsSection title="Text generators">
      <SettingsRow
        title="Model APIs"
        description="Add an API for thread titles, commits, and pull requests. Requests send the relevant text to the configured endpoint."
      />
      {Object.entries(props.generators).map(([rawId, generator]) => {
        const id = ProviderInstanceId.make(rawId);
        const selection = generator.model ? { instanceId: id, model: generator.model } : null;
        return (
          <SettingsRow
            key={id}
            title={generator.label ?? generator.baseUrl}
            description={`${generator.model ?? "No model set"}${generator.enabled ? "" : " · Disabled"}`}
            control={
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!props.canManage}
                  onClick={() => {
                    setEditing(id);
                    setKind(generator.kind);
                    setLabel(generator.label ?? "");
                    setBaseUrl(generator.baseUrl);
                    setModel(generator.model ?? "");
                    setApiKey("");
                    setClearKey(false);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!props.canSelect || !selection || !generator.enabled}
                  onClick={() => {
                    if (selection) void props.onPatch({ textGenerationModelSelection: selection });
                  }}
                >
                  Use for text generation
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!props.canSelect || !selection || !generator.enabled}
                  onClick={() => {
                    if (selection)
                      void props.onPatch({ sourceControlWriterModelSelection: selection });
                  }}
                >
                  Use for source control
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!props.canManage}
                  onClick={() =>
                    void props.onPatch({
                      textGenerators: { [id]: { ...generator, enabled: !generator.enabled } },
                    })
                  }
                >
                  {generator.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!props.canManage}
                  onClick={() => void props.onPatch({ textGenerators: { [id]: null } })}
                >
                  Remove
                </Button>
              </div>
            }
          />
        );
      })}
      {props.canManage ? (
        <SettingsRow
          title={editing === null ? "Add a text generator" : "Edit text generator"}
          control={
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (value === "openaiCompatible" || value === "anthropic") setKind(value);
                }}
              >
                <SelectTrigger aria-label="API type">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="openaiCompatible">OpenAI-compatible</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                </SelectPopup>
              </Select>
              <Input
                aria-label="Name"
                placeholder="Name (optional)"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
              <Input
                aria-label="API base URL"
                placeholder="https://api.example/v1"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <Input
                aria-label="Model ID"
                placeholder="Model ID"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
              <SecretInput
                aria-label="API key"
                placeholder="API key (optional)"
                configured={previous !== undefined && !clearKey && previous.apiKey !== ""}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setClearKey(false);
                }}
              />
              {previous && previous.apiKey !== "" && !clearKey ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setApiKey("");
                    setClearKey(true);
                  }}
                >
                  Clear saved key
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={!valid || busy}>
                {editing === null ? "Add text generator" : "Save text generator"}
              </Button>
              {editing !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(null);
                    setLabel("");
                    setBaseUrl("");
                    setModel("");
                    setApiKey("");
                    setClearKey(false);
                  }}
                >
                  Cancel edit
                </Button>
              ) : null}
            </form>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
