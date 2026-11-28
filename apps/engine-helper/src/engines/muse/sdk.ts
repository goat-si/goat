// Adapted from provider-muse/src/server/sdk.ts:48-58, 111-166, 171-229 at 916b5ccc1b2.
// The SDK owns the child process; close even when the initialize handshake fails.
import type { MspHandshake, SpawnMspConnectionOptions, SpawnedMspConnection } from "@muse-code/sdk";
import { loadSdk } from "../../sdkLoader.ts";

export interface MuseHostOptions {
  binary: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fullAccess?: boolean;
  timeoutMs?: number;
  readOnly?: boolean;
}

type MuseSdk = { spawnMspConnection(options: SpawnMspConnectionOptions): MspHandshake };

export function museEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== "META_API_KEY")),
    MUSE_NO_AUTO_UPDATE: "1",
  };
}

export function museServeArgs(fullAccess: boolean): string[] {
  return ["serve", "--trust-workspace", ...(fullAccess ? ["--disable-sandbox"] : [])];
}

export async function createMuseHost(options: MuseHostOptions): Promise<{
  host: SpawnedMspConnection;
  close: () => Promise<void>;
}> {
  const sdk = await loadSdk<MuseSdk>("muse", "@muse-code/sdk");
  const handshake = sdk.spawnMspConnection({
    command: options.binary,
    args: [...(options.args ?? []), ...(options.readOnly ? ["serve", "--disable-shell", "--disable-write", "--no-session-log"] : museServeArgs(options.fullAccess === true))],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: museEnvironment(options.env ?? process.env),
    shutdownTimeoutMs: 10_000,
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= handshake.close().then(() => undefined));
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Muse SDK initialization timed out.")), options.timeoutMs ?? 20_000);
      timer.unref();
    });
    const host = await Promise.race([
      handshake.initialize({
        clientInfo: { name: "t3_code", title: "T3 Code", version: "1" },
        capabilities: { requestedCapabilities: options.readOnly ? [] : ["sessionMcp"] },
      }),
      deadline,
    ]);
    if (host.initializeResult.schema?.version !== 1) {
      throw new Error("Muse SDK returned an unsupported protocol envelope version.");
    }
    return { host, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
