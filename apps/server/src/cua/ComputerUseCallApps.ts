/**
 * Which app each pid on this host runs, as lease proxies labelled it when reserving a call, so a
 * call that names only a pid shows its app's name and icon in the timeline. A pid names one
 * process whichever thread acts on it, so the map is host-wide. Display only; no window text.
 *
 * @module ComputerUseCallApps
 */
import type {
  ComputerUseCallAppLabel,
  OrchestrationV2TurnItem,
  ToolActivityNativeAppReference,
} from "@goat/contracts";
import { COMPUTER_USE_TOOL_SOURCE, cuaDriverToolName } from "@goat/shared/toolActivity";
import * as Context from "effect/Context";

import { targetPid } from "./ComputerUseScope.ts";

const MAX_APPS = 512;
const APP_ID = /^[A-Za-z0-9._-]+$/u;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : undefined;

/** The tool and arguments of a cua-driver call; ACP children keep it in {server, tool, arguments}. */
function driverCall(item: OrchestrationV2TurnItem) {
  if (item.type !== "dynamic_tool") return undefined;
  const input = record(item.input);
  const tool = cuaDriverToolName(item.toolName);
  if (tool !== undefined) return { tool, args: input };
  return input?.server === "cua-driver" && typeof input.tool === "string"
    ? { tool: input.tool, args: record(input.arguments) }
    : undefined;
}

export const makeCallApps = () => {
  const byPid = new Map<number, ComputerUseCallAppLabel>();
  const labelOf = (
    tool: string,
    args: Readonly<Record<string, unknown>> | undefined,
    output: unknown,
  ) => {
    if (tool === "launch_app") {
      const bundleId = text(args?.bundle_id, 255);
      // A launch by bundle id learns the app's name from its own answer.
      const launched = record(record(output)?.structuredContent) ?? record(output);
      const name =
        text(args?.name, 160) ??
        (bundleId !== undefined && text(launched?.bundle_id, 255) === bundleId
          ? text(launched?.name, 160)
          : undefined);
      if (bundleId !== undefined || name !== undefined)
        return {
          ...(bundleId === undefined ? {} : { bundleId }),
          ...(name === undefined ? {} : { name }),
        };
    }
    const pid = targetPid(args);
    return pid === undefined ? undefined : byPid.get(pid);
  };
  return {
    /** Keeps the app a reserved call's pid runs, as its proxy labelled it. */
    remember: (args: unknown, label: ComputerUseCallAppLabel) => {
      const pid = targetPid(record(args));
      if (pid === undefined) return;
      byPid.delete(pid);
      byPid.set(pid, label);
      const oldest = byPid.keys().next();
      if (byPid.size > MAX_APPS && oldest.done !== true) byPid.delete(oldest.value);
    },
    /**
     * A cua-driver call presented as its app, with the app's name and icon, when the call names
     * the app or acts on a pid a proxy labelled. Any other item, a call whose provider already
     * named its app, or an unknown pid stays as it came.
     */
    present: (item: OrchestrationV2TurnItem): OrchestrationV2TurnItem => {
      const call = driverCall(item);
      if (call === undefined) return item;
      if (
        item.toolSource?.kind === "computer" &&
        item.toolSource.key !== COMPUTER_USE_TOOL_SOURCE.key
      )
        return item;
      const label = labelOf(
        call.tool,
        call.args,
        item.type === "dynamic_tool" ? item.output : undefined,
      );
      const appId =
        label?.bundleId !== undefined && APP_ID.test(label.bundleId) ? label.bundleId : undefined;
      const name = label?.name ?? appId;
      if (name === undefined) return item;
      const app: ToolActivityNativeAppReference | undefined =
        appId !== undefined
          ? { _tag: "app-id", appId }
          : /[\\/]/u.test(name)
            ? undefined
            : { _tag: "display-name", displayName: name };
      const icon = app === undefined ? undefined : ({ _tag: "native-app", app } as const);
      return {
        ...item,
        toolSurface: "computer",
        ...(icon === undefined ? {} : { toolIcon: icon }),
        toolSource: {
          key:
            appId === undefined
              ? `native-app-name:${name.toLowerCase()}`
              : `native-app:${appId.toLowerCase()}`,
          name,
          kind: "computer",
          ...(icon === undefined ? {} : { icon }),
        },
      };
    },
  };
};

export class ComputerUseCallApps extends Context.Reference<ReturnType<typeof makeCallApps>>(
  "goat/cua/ComputerUseCallApps",
  { defaultValue: makeCallApps },
) {}
