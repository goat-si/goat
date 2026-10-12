import {
  initialGoatBotEnsure,
  retryGoatBotEnsure,
  startGoatBotEnsure,
  syncGoatBotEnsure,
} from "@t3tools/client-runtime/goatBot";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  settleMobileGoatBotEnsure,
  goatBotSessionKey,
  mobileGoatBotWaitingForHome,
  type MobileGoatBotEnsureDestination,
} from "./mobileGoatBotEnsure";

const destination = (id: string, generation = 1): MobileGoatBotEnsureDestination => ({
  environmentId: EnvironmentId.make(id),
  connectionKey: goatBotSessionKey({
    environmentId: EnvironmentId.make(id),
    generation,
    homeKey: "legacy",
  }),
});
const bot = (id: string) => ({
  environmentId: EnvironmentId.make(id),
  projectId: ProjectId.make(`project-${id}`),
  threadId: ThreadId.make(`bot-${id}`),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("mobile GOAT Bot ensure destination", () => {
  it("does not let delayed A overwrite B's persisted bot after selection changes", async () => {
    const a = destination("A");
    const b = destination("B");
    let selected = a;
    const requestA = startGoatBotEnsure(syncGoatBotEnsure(initialGoatBotEnsure, a.connectionKey));
    const requestB = startGoatBotEnsure(syncGoatBotEnsure(initialGoatBotEnsure, b.connectionKey));
    const responseA = deferred<ReturnType<typeof bot>>();
    const responseB = deferred<ReturnType<typeof bot>>();
    const persisted: string[] = [];
    const complete = async (
      request: typeof requestA,
      target: MobileGoatBotEnsureDestination,
      response: typeof responseA,
    ) => {
      const result = await response.promise;
      const settled = settleMobileGoatBotEnsure(
        request.machine,
        request.token,
        { kind: "confirmed", bot: result },
        target,
        selected,
      );
      if (settled !== request.machine) persisted.push(result.environmentId);
    };
    const completingA = complete(requestA, a, responseA);
    selected = b;
    const completingB = complete(requestB, b, responseB);
    responseB.resolve(bot("B"));
    await completingB;
    responseA.resolve(bot("A"));
    await completingA;
    expect(persisted).toEqual(["B"]);
  });

  it("rejects an old connection generation and a disconnected destination", () => {
    const target = destination("A");
    const request = startGoatBotEnsure(
      syncGoatBotEnsure(initialGoatBotEnsure, target.connectionKey),
    );
    for (const live of [destination("A", 2), { ...target, connectionKey: null }, null]) {
      expect(
        settleMobileGoatBotEnsure(
          request.machine,
          request.token,
          { kind: "confirmed", bot: bot("A") },
          target,
          live,
        ),
      ).toBe(request.machine);
    }
  });

  it("rejects the old token when returning to A on the same connection", () => {
    const target = destination("A");
    const oldRequest = startGoatBotEnsure(
      syncGoatBotEnsure(initialGoatBotEnsure, target.connectionKey),
    );
    const freshRequest = startGoatBotEnsure(retryGoatBotEnsure(oldRequest.machine));
    expect(
      settleMobileGoatBotEnsure(
        freshRequest.machine,
        oldRequest.token,
        { kind: "confirmed", bot: bot("A") },
        target,
        target,
      ),
    ).toBe(freshRequest.machine);
    expect(
      settleMobileGoatBotEnsure(
        freshRequest.machine,
        freshRequest.token,
        { kind: "confirmed", bot: bot("A") },
        target,
        target,
      ).ensure.state,
    ).toBe("confirmed");
  });

  it("rejects a bot returned for a different environment", () => {
    const target = destination("A");
    const request = startGoatBotEnsure(
      syncGoatBotEnsure(initialGoatBotEnsure, target.connectionKey),
    );
    expect(
      settleMobileGoatBotEnsure(
        request.machine,
        request.token,
        { kind: "confirmed", bot: bot("B") },
        target,
        target,
      ),
    ).toBe(request.machine);
  });
});

describe("mobile home session evidence", () => {
  it("includes home claim and connection generation in the same key", () => {
    expect(
      goatBotSessionKey({
        environmentId: EnvironmentId.make("A"),
        generation: 2,
        homeKey: "A:10:claim",
      }),
    ).toBe("A:2:channel:A:10:claim");
    expect(
      goatBotSessionKey({
        environmentId: EnvironmentId.make("A"),
        generation: null,
        homeKey: "legacy",
      }),
    ).toBeNull();
  });
  it("rejects every late result when the home winner changes during a request", () => {
    const requestDestination = {
      environmentId: EnvironmentId.make("A"),
      connectionKey: goatBotSessionKey({
        environmentId: EnvironmentId.make("A"),
        generation: 1,
        homeKey: "A:10:old",
      }),
    };
    const request = startGoatBotEnsure(
      syncGoatBotEnsure(initialGoatBotEnsure, requestDestination.connectionKey),
    );
    const live = {
      ...requestDestination,
      connectionKey: goatBotSessionKey({
        environmentId: requestDestination.environmentId,
        generation: 1,
        homeKey: "A:11:new",
      }),
    };
    for (const result of [
      { kind: "confirmed" as const, bot: bot("A") },
      { kind: "failed" as const, message: "not_home" },
    ]) {
      expect(
        settleMobileGoatBotEnsure(request.machine, request.token, result, requestDestination, live),
      ).toBe(request.machine);
    }
  });
  it("keeps not_home blocked across manual retry until home or snapshot changes", () => {
    const settingsSnapshot = {};
    const refusal = { homeKey: "A:10:claim", settingsSnapshot };
    const machine = retryGoatBotEnsure(
      syncGoatBotEnsure(initialGoatBotEnsure, destination("A").connectionKey),
    );
    expect(machine.ensure.state).toBe("idle");
    expect(mobileGoatBotWaitingForHome(refusal, "A:10:claim", settingsSnapshot)).toBe(true);
    expect(mobileGoatBotWaitingForHome(refusal, "B:11:claim", settingsSnapshot)).toBe(false);
    expect(mobileGoatBotWaitingForHome(refusal, "A:10:claim", {})).toBe(false);
    expect(mobileGoatBotWaitingForHome(null, "A:10:claim", settingsSnapshot)).toBe(false);
  });
});
