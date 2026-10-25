/**
 * What a lease proxy tells the server about each driver child it starts, for the host's record of
 * agent connections (ComputerUseAgentConnections): the first line a child writes proves the agent
 * route works, and a child that exits on its own before writing any line failed to start for this
 * connection. A child the proxy stopped itself (Stop, a pause, an expiry, a manifest refresh, the
 * proxy ending) says nothing about the route, and neither does one that exits after it answered.
 *
 * @module ComputerUseDriverWatch
 */
import type { ComputerUseDriverEndReason } from "@goat/contracts";

import { exitReason } from "./ComputerUseDriverExit.ts";

export type DriverWatchReport =
  | { readonly driverEnded: false }
  | {
      readonly driverEnded: {
        readonly reason: ComputerUseDriverEndReason;
        readonly exitCode?: number;
      };
    };

/**
 * One child's watch: feed it the child's events in order; each returns the report to send, if
 * any. At most one report per child.
 */
export const makeDriverWatch = () => {
  let settled = false;
  let stopping = false;
  const settle = (report: DriverWatchReport) => {
    if (settled) return undefined;
    settled = true;
    return report;
  };
  return {
    /** The child wrote a line on stdout: it answers. */
    answered: () => settle({ driverEnded: false }),
    /** The proxy is about to stop this child; its exit no longer counts. */
    stopping: () => {
      stopping = true;
    },
    /** The child exited, with its code when it had one. */
    exited: (code: number | undefined) =>
      stopping
        ? undefined
        : settle({
            driverEnded: {
              reason: exitReason(code),
              ...(code === undefined ? {} : { exitCode: code }),
            },
          }),
  };
};
