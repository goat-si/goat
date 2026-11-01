import { createFileRoute } from "@tanstack/react-router";
import { DecisionInbox } from "../components/decisions/DecisionInbox";

export const Route = createFileRoute("/_chat/decisions")({ component: DecisionInbox });
