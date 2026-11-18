// @effect-diagnostics nodeBuiltinImport:off -- Pen's control socket is a Node transport.
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

export const PEN_SNAPSHOT_LINE_CAP = 1 << 20;
export interface PenSnapshotMember {
  readonly nodeId: string;
  readonly noisePub: string;
  readonly name: string;
  readonly online: boolean;
}
export interface PenSnapshot {
  readonly gen: number;
  readonly mesh: string;
  readonly self: string;
  readonly members: ReadonlyArray<PenSnapshotMember>;
  readonly revoked: ReadonlyArray<{ readonly nodeId: string; readonly name: string }>;
}
export type PenWatchStale = "connect" | "refused" | "closed" | "gap" | "line";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z2-7]{26}$/.test(value);
const isName = (value: unknown): value is string => typeof value === "string" && value.length <= 64;
const isKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

export function parsePenSnapshot(line: string): PenSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.t !== "snapshot" ||
    !Number.isSafeInteger(value.gen) ||
    typeof value.gen !== "number" ||
    value.gen < 0 ||
    !isId(value.mesh) ||
    !isId(value.self) ||
    !Array.isArray(value.members) ||
    value.members.length > 4096 ||
    !Array.isArray(value.revoked) ||
    value.revoked.length > 4096
  )
    return undefined;
  const members: PenSnapshotMember[] = [];
  for (const member of value.members) {
    if (
      !isObject(member) ||
      !isId(member.nodeId) ||
      !isKey(member.noisePub) ||
      !isName(member.name) ||
      (member.online !== undefined && typeof member.online !== "boolean")
    )
      return undefined;
    members.push({
      nodeId: member.nodeId,
      noisePub: member.noisePub,
      name: member.name,
      online: member.online ?? false,
    });
  }
  const revoked: { nodeId: string; name: string }[] = [];
  for (const entry of value.revoked) {
    if (!isObject(entry) || !isId(entry.nodeId) || !isName(entry.name)) return undefined;
    revoked.push({ nodeId: entry.nodeId, name: entry.name });
  }
  return { gen: value.gen, mesh: value.mesh, self: value.self, members, revoked };
}

export function penStateDir(
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string | undefined {
  const penHome = env.PEN_HOME;
  return penHome
    ? NodePath.isAbsolute(penHome)
      ? penHome
      : undefined
    : NodePath.join(homeDirectory, ".pen");
}

export async function penLeftMesh(stateDir: string): Promise<boolean> {
  try {
    await NodeFSP.access(NodePath.join(stateDir, "left"));
    return true;
  } catch {
    return false;
  }
}

export function watchPenSnapshots(input: {
  readonly stateDir: string;
  readonly onSnapshot: (snapshot: PenSnapshot) => void;
  readonly onStale: (reason: PenWatchStale) => void;
  readonly connect?: (path: string) => NodeNet.Socket;
}): () => void {
  let active = true;
  let previous: number | undefined;
  let pending = Buffer.alloc(0);
  let socket: NodeNet.Socket;
  const fail = (reason: PenWatchStale) => {
    if (!active) return;
    active = false;
    socket.destroy();
    input.onStale(reason);
  };
  try {
    // oxlint-disable-next-line goat/guard-error-emitters -- the listener is attached immediately below; this package has no shared runtime dependency.
    socket = (input.connect ?? NodeNet.createConnection)(
      NodePath.join(input.stateDir, "control.sock"),
    );
  } catch {
    active = false;
    input.onStale("connect");
    return () => {};
  }
  socket.on("error", () => fail("connect"));
  socket.on("close", () => fail("closed"));
  socket.once("connect", () => {
    if (active) socket.write('{"op":"watch.snapshot"}\n');
  });
  socket.on("data", (chunk: Buffer) => {
    if (!active) return;
    let start = 0;
    while (start < chunk.length) {
      if (!active) return;
      const end = chunk.indexOf(10, start);
      const length = (end < 0 ? chunk.length : end + 1) - start;
      if (pending.length + length > PEN_SNAPSHOT_LINE_CAP) {
        fail("line");
        return;
      }
      pending = Buffer.concat([pending, chunk.subarray(start, start + length)]);
      start += length;
      if (end < 0) return;
      const line = pending.subarray(0, -1).toString("utf8");
      pending = Buffer.alloc(0);
      const snapshot = parsePenSnapshot(line);
      if (!snapshot) {
        let response: unknown;
        try {
          response = JSON.parse(line);
        } catch {
          /* invalid line */
        }
        fail(isObject(response) && typeof response.error === "string" ? "refused" : "line");
        return;
      }
      if (previous !== undefined && snapshot.gen !== previous + 1) {
        fail("gap");
        return;
      }
      previous = snapshot.gen;
      input.onSnapshot(snapshot);
    }
  });
  return () => {
    active = false;
    socket.destroy();
  };
}
