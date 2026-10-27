import { createFileRoute } from "@tanstack/react-router";

import { GoatBotSettingsPanel } from "../components/settings/GoatBotSettingsPage";

export const Route = createFileRoute("/settings/goat-bot")({
  component: GoatBotSettingsPanel,
});
