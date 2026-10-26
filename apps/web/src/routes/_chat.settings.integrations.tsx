import { createFileRoute, redirect } from "@tanstack/react-router";

import { IntegrationsSettingsPanel } from "../components/settings/IntegrationsSettings";
import { isGoatBotSettingsTarget } from "../components/settings/settingsSearch";

export const Route = createFileRoute("/_chat/settings/integrations")({
  // GOAT Bot and Slack used to live here; old links and bookmarks land on their own page.
  beforeLoad: ({ location }) => {
    if (isGoatBotSettingsTarget(location.hash)) {
      throw redirect({ to: "/settings/goat-bot", hash: location.hash, replace: true });
    }
  },
  component: IntegrationsSettingsPanel,
});
