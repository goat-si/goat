import { createFileRoute } from "@tanstack/react-router";
import { NotePath } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { NotesPage } from "../notes/NotesPage";

const isNotePath = Schema.is(NotePath);

export const Route = createFileRoute("/_chat/notes")({
  validateSearch: (search: Record<string, unknown>): { path?: string; create?: boolean } => ({
    ...(isNotePath(search.path) ? { path: search.path } : {}),
    ...(search.create === true ? { create: true } : {}),
  }),
  component: NotesRoute,
});
function NotesRoute() {
  return <NotesPage {...Route.useSearch()} />;
}
