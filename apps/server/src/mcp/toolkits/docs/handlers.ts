import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as UserDocs from "../../../userDocs/UserDocs.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DocsToolkit } from "./tools.ts";

type DocsError =
  | UserDocs.UserDocsUnavailableError
  | UserDocs.UserGuideNotFoundError
  | UserDocs.UserGuideCursorError;

const failure = (error: DocsError) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "UserGuideNotFoundError"
        ? "not_found"
        : error._tag === "UserGuideCursorError"
          ? "invalid_request"
          : "orchestration_error",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(DocsToolkit, {
  goat_docs_search: McpToolAccess.reads((input) =>
    UserDocs.UserDocs.pipe(
      Effect.flatMap((docs) => docs.search(input)),
      Effect.mapError(failure),
    ),
  ),
  goat_docs_read: McpToolAccess.reads(({ page, section, cursor }) =>
    Effect.gen(function* () {
      const docs = yield* UserDocs.UserDocs;
      if (page !== undefined)
        return yield* docs.read({ page, section, cursor }).pipe(Effect.mapError(failure));
      if (section !== undefined || cursor !== undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "section and cursor need the page they belong to.",
        });
      return yield* docs.index.pipe(Effect.mapError(failure));
    }),
  ),
});
