import { createFileRoute } from "@tanstack/react-router";
import { HubSettings } from "../components/settings/HubSettings";

export const Route = createFileRoute("/settings/hub")({
  component: HubSettings,
});
