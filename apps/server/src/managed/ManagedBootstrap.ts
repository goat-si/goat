import { DesktopBackendBootstrap, type DesktopBackendHealth } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { readBootstrapEnvelope } from "../bootstrap.ts";
import { installManagedHeartbeat, type InstalledHeartbeat } from "./ManagedHeartbeat.ts";

let cached: { fd: number; value: Option.Option<DesktopBackendBootstrap> } | undefined;
let heartbeat: InstalledHeartbeat | undefined;
let retired = false;
export const readDesktopBootstrap = Effect.fn("ManagedBootstrap.read")(function* (fd: number) {
  if (cached?.fd === fd) return cached.value;
  return yield* readBootstrapEnvelope(DesktopBackendBootstrap, fd);
});
export async function prepareManagedDesktopBootstrap(fd: number): Promise<void> {
  const value = await Effect.runPromise(readDesktopBootstrap(fd));
  cached = { fd, value };
  const bootstrap = Option.getOrUndefined(value);
  if (bootstrap?.backendWatchdog !== undefined)
    heartbeat = await installManagedHeartbeat(bootstrap.backendWatchdog);
}
export const publishManagedPhase = (phase: DesktopBackendHealth["phase"]) =>
  heartbeat?.publish(phase) ?? !retired;
export async function closeManagedHeartbeat() {
  retired ||= heartbeat?.isRetired() ?? false;
  await heartbeat?.close();
  heartbeat = undefined;
}

export const isManagedHeartbeatRetired = () => retired || (heartbeat?.isRetired() ?? false);
