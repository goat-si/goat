import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { GoatProjectFile, GOAT_PROJECT_FILE_SCHEMA_URL } from "@goat/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const GoatProjectFileFromJson = fromLenientJson(GoatProjectFile);

const decodeGoatProjectFile = Schema.decodeExit(GoatProjectFileFromJson);

export function parseGoatProjectFile(contents: string): GoatProjectFile | null {
  const decoded = decodeGoatProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildGoatProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(GoatProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: GOAT_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
