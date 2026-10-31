import {
  addBlockedBrowserHost,
  removeBlockedBrowserHost,
} from "@goat/client-runtime/blocked-browser-hosts";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettingsWriteAllowed, useUpdateScopedSettings } from "./useScopedSettings";

export function BlockedBrowserHostsSetting() {
  const { scope, targets } = useSettingsScope();
  const canWrite = useScopedSettingsWriteAllowed();
  const update = useUpdateScopedSettings();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hosts = targets.length === 1 ? targets[0]?.settings.blockedBrowserHosts : undefined;
  const disabled =
    !canWrite || hosts === undefined || scope.kind === "project" || scope.kind === "checkout";
  const add = () => {
    if (disabled || hosts === undefined) return;
    const result = addBlockedBrowserHost(hosts, input);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    update({ blockedBrowserHosts: result.hosts });
    setInput("");
    setError(null);
  };
  return (
    <SettingsRow
      title="Blocked browser hosts"
      description="Agents cannot use these hosts or their subdomains. Select one environment to edit its list."
      serverScoped
      settingKeys={["blockedBrowserHosts"]}
      control={
        <div className="flex w-full flex-col gap-2">
          {(hosts ?? []).map((host) => (
            <div key={host} className="flex items-center justify-between gap-2">
              <span className="text-sm">{host}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                aria-label={`Remove ${host}`}
                onClick={() =>
                  update({ blockedBrowserHosts: removeBlockedBrowserHost(hosts ?? [], host) })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Input
              aria-label="Host to block"
              aria-invalid={error !== null}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={disabled}
              placeholder="example.com"
            />
            <Button variant="outline" size="sm" disabled={disabled} onClick={add}>
              Add
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
