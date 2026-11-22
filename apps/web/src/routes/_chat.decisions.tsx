import { createFileRoute } from "@tanstack/react-router";
import { readDecisionRequestTarget } from "@goat/client-runtime/state/decision-inbox";
import { DecisionInbox } from "../components/decisions/DecisionInbox";

export const Route = createFileRoute("/_chat/decisions")({
  validateSearch: (search): Partial<NonNullable<ReturnType<typeof readDecisionRequestTarget>>> =>
    readDecisionRequestTarget(search) ?? {},
  component: DecisionsRoute,
});

function DecisionsRoute() {
  return <DecisionInbox target={readDecisionRequestTarget(Route.useSearch())} />;
}
