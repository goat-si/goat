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
): Promise<ReadonlyMap<string, DiskSwarmMember>> {
  const file = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", rootSessionId, ".system_generated", "swarm", "members.json"],
    "file",
  );
  if (file === undefined || file.info.size > maxStepBytes) return new Map();
  const raw = await NodeFSP.readFile(file.path, "utf8").catch(() => undefined);
  if (raw === undefined) return new Map();
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
