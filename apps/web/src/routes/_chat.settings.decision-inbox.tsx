import { createFileRoute } from "@tanstack/react-router";
import { DecisionInboxSettings } from "../components/settings/DecisionInboxSettings";

export const Route = createFileRoute("/_chat/settings/decision-inbox")({
  component: DecisionInboxSettings,
});
