import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useGT } from "gt-react";
import type { EnvironmentId, UnifiedSettings, UsageLimitSourceConfig } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "~/components/solar";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { SecretReferencePicker } from "./SecretReferencePicker";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  cursorKeychainUsageEnabled,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly cursorKeychainUsageEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const localizedSetting = useTranslatedSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const platform = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .platform;
  const [adding, setAdding] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const entries = Object.entries(sources);

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    const result = await updateCursorSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: enabled } },
    });
    if (result._tag === "Success") {
      await refreshProviders({ environmentId, input: {} });
    }
    setUpdatingCursor(false);
  };

  return (
    <>
      <SettingsSection
        {...localizedSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              {gt("Add CLIProxyAPI hub")}
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title={gt("Cursor account usage")}
            description={gt(
              "Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access.",
            )}
            control={
              <Switch
                aria-label={gt("Cursor account usage")}
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow title={gt("No CLIProxyAPI hubs added.")} />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    CLI Proxy{source.enabled ? "" : " · Disabled"}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                status={
                  source.managementKeyReference != null || source.managementKey === "" ? (
                    <>
                      {source.managementKeyReference == null ? (
                        <span>{gt("Management key not set. Re-enter it for this address.")}</span>
                      ) : null}
                      <UsageSourceReference
                        environmentId={environmentId}
                        source={source}
                        readOnly={readOnly}
                        onSave={(next) => updateSettings({ usageLimitSources: { [id]: next } })}
                      />
                    </>
                  ) : null
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
    </>
  );
}

function UsageSourceReference({
  environmentId,
  source,
  readOnly,
  onSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly source: UsageLimitSourceConfig;
  readonly readOnly: boolean;
  readonly onSave: (source: UsageLimitSourceConfig) => void;
}) {
  const gt = useGT();
  const [stored, setStored] = useState(
    source.managementKeyReference == null && source.managementKey === "",
  );
  const [key, setKey] = useState("");
  return (
    <div>
      <SecretReferencePicker
        environmentId={environmentId}
        value={source.managementKeyReference ?? undefined}
        disabled={readOnly}
        onChange={(reference) => {
          if (reference === undefined) setStored(true);
          else {
            setStored(false);
            onSave({ ...source, managementKey: "", managementKeyReference: reference });
          }
        }}
      />
      {stored && !readOnly ? (
        <div>
          <SecretInput
            aria-label={gt("Replacement management key")}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button
            size="xs"
            disabled={!key.trim()}
            onClick={() => {
              onSave({ ...source, managementKey: key.trim(), managementKeyReference: null });
              setStored(false);
              setKey("");
            }}
          >
            {gt("Save key")}
          </Button>
          {source.managementKeyReference != null || source.managementKey !== "" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setStored(false);
                setKey("");
              }}
            >
              {gt("Cancel")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {gt("Remove")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {gt(
                "The hub's management key is deleted from this server. Its accounts leave the Limits view; the hub itself is untouched. Add it again with the URL and key to bring them back.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {gt("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {gt("Remove hub")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
