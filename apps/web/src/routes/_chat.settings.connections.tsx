import { createFileRoute, redirect } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

export const Route = createFileRoute("/_chat/settings/connections")({
  // The hub's device list moved to Settings → Hub; old links and bookmarks follow it.
  beforeLoad: ({ location }) => {
    if (location.hash === "hub-nodes") {
      throw redirect({ to: "/settings/hub", hash: "hub-nodes", replace: true });
    }
  },
  component: ConnectionsSettings,
});
