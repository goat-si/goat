import { AcpRegistryDriver, type AcpRegistryDriverEnv } from "@goat/provider-acp-registry/server";
import { AntigravityDriver, type AntigravityDriverEnv } from "./Drivers/AntigravityDriver.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { ClaudeCloudDriver, type ClaudeCloudDriverEnv } from "./Drivers/ClaudeCloudDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import {
  CursorDriver,
  type CursorDriverEnv,
  CursorCloudDriver,
  type CursorCloudDriverEnv,
} from "@goat/provider-cursor/server";
import { DevinCloudDriver, type DevinCloudDriverEnv } from "@goat/provider-devin-cloud/server";
import { GrokDriver, type GrokDriverEnv } from "@goat/provider-grok/server";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@goat/provider-opencode/server";
import { MuseDriver, type MuseDriverEnv } from "@goat/provider-muse/server";
import { PiDriver, type PiDriverEnv } from "@goat/provider-pi/server";
import type { AnyProviderDriver, ProviderUsageReaderEnv } from "@goat/provider-core/server/driver";

export type BuiltInDriversEnv =
  | AcpRegistryDriverEnv
  | AntigravityDriverEnv
  | ClaudeDriverEnv
  | ClaudeCloudDriverEnv
  | CodexDriverEnv
  | CursorDriverEnv
  | CursorCloudDriverEnv
  | DevinCloudDriverEnv
  | GrokDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv
  | MuseDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  ClaudeCloudDriver,
  CursorDriver,
  CursorCloudDriver,
  GrokDriver,
  OpenCodeDriver,
  AntigravityDriver,
  PiDriver,
  MuseDriver,
  AcpRegistryDriver,
  DevinCloudDriver,
];

export type BuiltInUsageReadersEnv =
  | ProviderUsageReaderEnv<typeof ClaudeDriver>
  | ProviderUsageReaderEnv<typeof CodexDriver>
  | ProviderUsageReaderEnv<typeof GrokDriver>
  | ProviderUsageReaderEnv<typeof OpenCodeDriver>
  | ProviderUsageReaderEnv<typeof AntigravityDriver>
  | ProviderUsageReaderEnv<typeof CursorDriver>
  | ProviderUsageReaderEnv<typeof PiDriver>
  | ProviderUsageReaderEnv<typeof MuseDriver>;

/**
 * Aggregation keeps the first copy of a duplicate record, so the order is part
 * of the result.
 */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [
  ClaudeDriver,
  CodexDriver,
  GrokDriver,
  PiDriver,
  OpenCodeDriver,
  MuseDriver,
  AntigravityDriver,
  CursorDriver,
];
