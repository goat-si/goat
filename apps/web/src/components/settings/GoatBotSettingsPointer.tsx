import { useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function GoatBotSettingsPointer() {
  const gt = useGT();
  const navigate = useNavigate();
  return (
    <SettingsSection id="goat-bot-pointer" title="GOAT Bot">
      <SettingsRow
        title={gt("GOAT Bot and Slack")}
        description={gt("Choose where GOAT Bot runs and connect it to Slack.")}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/goat-bot", hash: "" })}
          >
            {gt("Open")}
          </Button>
        }
      />
    </SettingsSection>
  );
}
