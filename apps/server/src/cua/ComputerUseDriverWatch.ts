/** @module ComputerUseDriverWatch */
import type { ComputerUseDriverEndReason } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { exitReason } from "./ComputerUseDriverExit.ts";

export type DriverWatchReport =
  | { readonly driverEnded: false }
  | {
      readonly driverEnded: {
        readonly reason: ComputerUseDriverEndReason;
        readonly exitCode?: number;
      };
    };

const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const requestId = (value: unknown): value is string | number =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Each child proves its route with its own initialize exchange, including replayed wire IDs. */
export const makeDriverWatch = () => {
  let settled = false;
  let stopping = false;
  const pending = new Map<string, string>();
  const settle = (report: DriverWatchReport) => {
    if (settled || stopping) return undefined;
    settled = true;
    pending.clear();
    return report;
  };
  return {
    sent: (line: string) => {
      if (settled || stopping) return;
      const decoded = decodeMessage(line);
      if (Option.isNone(decoded)) return;
      const message = decoded.value;
      if (
        message.jsonrpc !== "2.0" ||
        message.method !== "initialize" ||
        !requestId(message.id) ||
        !record(message.params) ||
        !nonempty(message.params.protocolVersion) ||
        Object.hasOwn(message, "result") ||
        Object.hasOwn(message, "error")
      )
        return;
      pending.set(JSON.stringify(message.id), message.params.protocolVersion);
    },
    received: (line: string) => {
      if (settled || stopping) return undefined;
      const decoded = decodeMessage(line);
      if (Option.isNone(decoded)) return undefined;
      const message = decoded.value;
      if (!requestId(message.id) || Object.hasOwn(message, "method")) return undefined;
      const key = JSON.stringify(message.id);
      const version = pending.get(key);
      if (version === undefined) return undefined;
      // A failed reply consumes the request too; a later success needs a new initialize send.
      pending.delete(key);
      const result = message.result;
      if (
        message.jsonrpc !== "2.0" ||
        Object.hasOwn(message, "error") ||
        !record(result) ||
        result.protocolVersion !== version ||
        !record(result.capabilities) ||
        !record(result.serverInfo) ||
        !nonempty(result.serverInfo.name) ||
        !nonempty(result.serverInfo.version)
      )
        return undefined;
      return settle({ driverEnded: false });
    },
    stopping: () => {
      stopping = true;
      pending.clear();
    },
    exited: (code: number | undefined) =>
      settle({
        driverEnded: {
          reason: exitReason(code),
          ...(code === undefined ? {} : { exitCode: code }),
        },
      }),
  };
};
