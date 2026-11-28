// @effect-diagnostics nodeBuiltinImport:off -- reads native Antigravity swarm state read-only beside AntigravityChildWork.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { antigravityManagedPath } from "./AntigravityProfilePaths.ts";

export interface AntigravityChildLaunch {
  readonly role: string;
  readonly prompt: string;
}

const SwarmAddInput = Schema.Struct({
  action: Schema.String,
  name: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
  n: Schema.optional(Schema.Number),
  tasks: Schema.optional(Schema.Array(Schema.String)),
});
const decodeSwarmAddInput = Schema.decodeUnknownOption(SwarmAddInput);

// The tool input is untrusted; a huge `n` must not allocate a launch per requested worker.
const MAX_SWARM_ADD_LAUNCHES = 64;

export function swarmAddLaunches(
  input: unknown,
): ReadonlyArray<AntigravityChildLaunch> | undefined {
  const decoded = Option.getOrUndefined(decodeSwarmAddInput(input));
  if (decoded === undefined || decoded.action.trim().toLowerCase() !== "add") return undefined;
  const baseName = decoded.name?.trim().replace(/^@/, "") ?? "";
  const brief = decoded.brief?.trim() ?? "";
  const tasks = decoded.tasks ?? [];
  const requestedCount =
    decoded.n !== undefined && Number.isFinite(decoded.n) ? Math.trunc(decoded.n) : 0;
  const count = Math.min(Math.max(tasks.length, requestedCount, 1), MAX_SWARM_ADD_LAUNCHES);
  const roleSuffix =
    decoded.role !== undefined && decoded.role.trim().length > 0 && decoded.role !== "worker"
      ? ` (${decoded.role.trim()})`
      : "";

  if (count === 1) {
    const task = tasks[0]?.trim() ?? "";
    const prompt = brief.length > 0 && task.length > 0 ? `${brief}\n\n${task}` : brief || task;
    return [
      {
        role: baseName.length > 0 ? `@${baseName}${roleSuffix}` : `Swarm worker${roleSuffix}`,
        prompt,
      },
    ];
  }

  return Array.from({ length: count }, (_, index) => {
    const task = tasks[index]?.trim() ?? "";
    const prompt = brief.length > 0 && task.length > 0 ? `${brief}\n\n${task}` : task || brief;
    const role =
      baseName.length > 0
        ? `@${baseName}-${index + 1}${roleSuffix}`
        : `Swarm worker ${index + 1}${roleSuffix}`;
    return { role, prompt };
  });
}

export function swarmRoleLabel(descriptorRole: string | undefined): string | undefined {
  const trimmed = descriptorRole?.trim() ?? "";
  const match = /^Swarm Worker \((.+)\)$/.exec(trimmed);
  return match?.[1] !== undefined ? `@${match[1].trim()}` : undefined;
}

const decodeSwarmRoster = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      members: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            conversation_id: Schema.optional(Schema.String),
            role: Schema.optional(Schema.String),
            desired_state: Schema.optional(Schema.String),
            phase: Schema.optional(Schema.String),
            wake_mode: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

export interface DiskSwarmMember {
  readonly name: string;
  readonly role: string;
  readonly killed: boolean;
  readonly parked: boolean;
}

export async function readDiskSwarmMembersByConversationId(
  profileRoot: string,
  rootSessionId: string,
  maxStepBytes: number,
  nativeIdPattern: RegExp,
  options?: { readonly beforeOpen?: () => Promise<void> },
): Promise<ReadonlyMap<string, DiskSwarmMember>> {
  const segments = [
    "antigravity-acp",
    "brain",
    rootSessionId,
    ".system_generated",
    "swarm",
    "members.json",
  ] as const;
  const file = await antigravityManagedPath(profileRoot, segments, "file");
  if (file === undefined || file.info.size > maxStepBytes) return new Map();
  if (options?.beforeOpen !== undefined) {
    await options.beforeOpen();
  }
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      file.path,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return new Map();
  }
  let raw: string | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxStepBytes) return new Map();
    // Re-verify the canonical managed path matches the opened fd inode so a component swap
    // between initial validation and open cannot direct reads outside the profile.
    const verified = await antigravityManagedPath(profileRoot, segments, "file");
    if (
      verified === undefined ||
      verified.info.dev !== stat.dev ||
      verified.info.ino !== stat.ino
    ) {
      return new Map();
    }
    const buffer = Buffer.alloc(maxStepBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxStepBytes) return new Map();
    raw = buffer.toString("utf8", 0, offset);
  } catch {
    return new Map();
  } finally {
    await handle.close().catch(() => undefined);
  }
  const decoded = Option.getOrUndefined(decodeSwarmRoster(raw));
  const members = decoded?.members;
  if (members === undefined) return new Map();
  const byConversation = new Map<string, DiskSwarmMember>();
  for (const [name, member] of Object.entries(members)) {
    const convId = member.conversation_id;
    if (convId === undefined || !nativeIdPattern.test(convId)) continue;
    const role = member.role ?? "worker";
    if (role === "coordinator") continue;
    const killed = member.desired_state === "KILLED" || member.phase === "KILLED";
    const parked = member.wake_mode === "mentions" || member.wake_mode === "anything";
    byConversation.set(convId, { name, role, killed, parked });
  }
  return byConversation;
}
