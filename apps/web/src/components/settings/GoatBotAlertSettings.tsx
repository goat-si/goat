import { useGT } from "gt-react";
import { goatBotAlertChoices } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { useEnvironments } from "../../state/environments";
import { useGoatBotModel } from "../goatBot/useGoatBotModel";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function GoatBotAlertSettings() {
  const gt = useGT();
  const computers = useEnvironments().environments.filter(
    (computer) =>
      computer.connection.phase === "connected" &&
      computer.serverConfig?.environment.capabilities.goatBotAttention === true,
  );
  if (computers.length === 0) return null;
  return (
    <SettingsSection id="goat-bot-alerts" title={gt("Bot alerts")}>
      {computers.map((computer) => (
        <GoatBotAlertRow
          key={computer.environmentId}
          environmentId={computer.environmentId}
          label={computer.label}
        />
      ))}
    </SettingsSection>
  );
}

function GoatBotAlertRow({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const gt = useGT();
  const labels = {
    needs_you: gt("Needs you"),
    needs_you_and_results: gt("Needs you and results"),
    off: gt("Off"),
  };
  const alertChoices = goatBotAlertChoices.map(({ value }) => ({ value, label: labels[value] }));
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const { settings, allowed, save, message } = useGoatBotModel(environmentId);
  return (
    <SettingsRow
      title={label}
      description={gt("Show notifications from this computer while GOAT is running.")}
      status={message ?? permissionMessage}
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {settings.goatBotAlerts !== "off" &&
          typeof Notification !== "undefined" &&
          Notification.permission !== "granted" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void Notification.requestPermission().then(
                  (permission) => {
                    setPermissionMessage(
                      permission === "granted"
                        ? gt("Notifications allowed.")
                        : gt("Allow notifications in your browser or system settings."),
                    );
                  },
                  () => setPermissionMessage("Notifications are unavailable in this browser."),
                );
              }}
            >
              {gt("Allow notifications")}
            </Button>
          ) : null}
          <Select
            value={settings.goatBotAlerts}
            items={alertChoices}
            disabled={!allowed}
            onValueChange={(value) => {
              if (value !== null) void save({ goatBotAlerts: value });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={gt("Bot alerts on {computer}", { computer: label })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {alertChoices.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
