import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ConnectionAddedBy,
  ConnectionCatalogHostRequest,
  ConnectionCatalogRequestId,
} from "./connectionCatalog.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

const oldRequest = Schema.Struct({
  requestId: ConnectionCatalogRequestId,
  expiresAt: IsoDateTime,
  operation: Schema.Struct({
    type: Schema.Literal("add_ssh"),
    host: TrimmedNonEmptyString,
    label: Schema.optionalKey(TrimmedNonEmptyString),
    addedBy: ConnectionAddedBy,
  }),
});
const decodeOld = Schema.decodeUnknownSync(oldRequest);
const decodeCurrent = Schema.decodeUnknownSync(ConnectionCatalogHostRequest);

it("accepts add SSH requests across old and new desktop schemas", () => {
  const request = {
    requestId: "request",
    expiresAt: "2026-11-25T00:00:00.000Z",
    operation: {
      type: "add_ssh",
      host: "build",
      addedBy: { kind: "agent", at: "2026-11-25T00:00:00.000Z" },
    },
  };
  const identified = {
    ...request,
    operation: { ...request.operation, reachedEnvironmentId: "build-id" },
  };
  expect(decodeCurrent(identified).operation).toMatchObject({ reachedEnvironmentId: "build-id" });
  expect(decodeCurrent(request).operation).not.toHaveProperty("reachedEnvironmentId");
  expect(decodeOld(identified).operation).toMatchObject({
    type: "add_ssh",
    host: "build",
  });
});
