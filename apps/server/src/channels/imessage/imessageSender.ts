// @effect-diagnostics nodeBuiltinImport:off -- fixed osascript process requires Node child events.
import * as NodeChildProcess from "node:child_process";
import * as NodeTimers from "node:timers";

import { ChannelGatewayError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type { ChannelTransport } from "../ChannelTransport.ts";

export type ImessageSendFailure = {
  readonly outcome: "not_sent" | "unknown";
  readonly code: "automation_denied" | "chat_not_found" | "no_service" | "timeout" | "unknown";
};
export interface ImessageSender {
  readonly sendText: (input: {
    readonly chatGuid: string;
    readonly text: string;
  }) => Promise<{ readonly acceptedAt: string } | ImessageSendFailure>;
}

export const IMESSAGE_SCRIPT = `on run argv
  set targetID to item 1 of argv
  set messageText to item 2 of argv
  tell application "Messages"
    set targetChat to get chat id targetID
    send messageText to targetChat
  end tell
end run
`;

export function makeOsascriptImessageSender(
  input: {
    readonly timeoutMs?: number;
    readonly spawnProcess?: typeof NodeChildProcess.spawn;
  } = {},
): ImessageSender {
  return {
    sendText: ({ chatGuid, text }) =>
      new Promise((resolve) => {
        if (!chatGuid.trim() || !text.trim()) {
          resolve({ outcome: "not_sent", code: "unknown" });
          return;
        }
        let child: NodeChildProcess.ChildProcessWithoutNullStreams;
        try {
          child = (input.spawnProcess ?? NodeChildProcess.spawn)(
            "/usr/bin/osascript",
            ["-l", "AppleScript", "-", chatGuid, text],
            { shell: false, stdio: ["pipe", "pipe", "pipe"] },
          ) as NodeChildProcess.ChildProcessWithoutNullStreams;
        } catch {
          resolve({ outcome: "not_sent", code: "unknown" });
          return;
        }
        let done = false;
        let started = false;
        let stderr = "";
        const finish = (result: { readonly acceptedAt: string } | ImessageSendFailure) => {
          if (done) return;
          done = true;
          NodeTimers.clearTimeout(timer);
          resolve(result);
        };
        // @effect-diagnostics-next-line globalTimers:off -- this Promise owns one spawned process and clears its timer on completion.
        const timer = NodeTimers.setTimeout(() => {
          finish({ outcome: "unknown", code: "timeout" });
          try {
            child.kill();
          } catch {
            // The send outcome is already ambiguous; process termination is best effort.
          }
        }, input.timeoutMs ?? 15_000);
        child.once("spawn", () => {
          started = true;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4096);
        });
        child.stdout.on("data", () => {});
        child.stdin.once("error", () =>
          finish({ outcome: started ? "unknown" : "not_sent", code: "unknown" }),
        );
        child.once("error", () =>
          finish({ outcome: started ? "unknown" : "not_sent", code: "unknown" }),
        );
        child.once("close", (code) => {
          if (done) return;
          if (code === 0) {
            finish({ acceptedAt: DateTime.formatIso(DateTime.nowUnsafe()) });
            return;
          }
          if (/\(-1743\)/.test(stderr)) {
            finish({ outcome: "not_sent", code: "automation_denied" });
            return;
          }
          if (/\(-1728\)/.test(stderr)) {
            finish({ outcome: "not_sent", code: "chat_not_found" });
            return;
          }
          finish({ outcome: "unknown", code: "unknown" });
        });
        child.stdin.end(IMESSAGE_SCRIPT);
      }),
  };
}

export function makeImessageTransport(input: {
  readonly connectionId: string;
  readonly sender: ImessageSender;
  readonly isActive: () => Effect.Effect<boolean>;
}): ChannelTransport {
  return {
    kind: "imessage",
    send: (message) =>
      Effect.gen(function* () {
        const target = message.destination;
        if (target.kind !== "imessage" || target.connectionId !== input.connectionId)
          return yield* new ChannelGatewayError({ reason: "invalid_input" });
        if (!(yield* input.isActive()))
          return yield* new ChannelGatewayError({ reason: "adapter_unavailable" });
        const result = yield* Effect.promise(() =>
          input.sender.sendText({ chatGuid: target.chatGuid, text: message.text }),
        );
        if ("outcome" in result) {
          const code =
            result.code === "automation_denied"
              ? "invalid_auth"
              : result.code === "chat_not_found"
                ? "channel_not_found"
                : result.code === "no_service"
                  ? "invalid_auth"
                  : result.code === "timeout"
                    ? "timeout"
                    : "unknown";
          return yield* new ChannelGatewayError({
            reason: "delivery_failed",
            deliveryOutcome: result.outcome,
            deliveryErrorCode: code,
          });
        }
        return { deliveryId: message.deliveryId, acceptedAt: result.acceptedAt };
      }),
  };
}
