import { Persistence } from "@goat/client-runtime/platform";
import { EnvironmentId } from "@goat/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  outbox: vi.fn(),
  drafts: vi.fn(),
  errors: vi.fn(),
  bot: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("../state/thread-outbox-removal", () => ({ clearThreadOutboxEnvironment: state.outbox }));
vi.mock("../state/use-composer-drafts", () => ({ clearComposerDraftsEnvironment: state.drafts }));
vi.mock("../state/thread-composer-error", () => ({
  clearThreadComposerErrorsForEnvironment: state.errors,
}));
vi.mock("../features/goat-bot/useMobileGoatBotSession", () => ({
  disposeMobileGoatBotEnvironment: state.bot,
}));
vi.mock("@goat/client-runtime/goatBot", () => ({ forgetNewBotEnvironment: state.forget }));
import { layerEnvironmentOwnedDataCleanup } from "./environment-owned-data-cleanup";

it.effect("isolates failures and waits for the other environment clears", () => {
  const slow = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const warnings: unknown[] = [];
  const logger = Logger.layer([Logger.make(({ message }) => warnings.push(message))], {
    mergeWithExisting: false,
  });
  state.outbox.mockRejectedValueOnce(new Error("outbox"));
  state.drafts.mockImplementationOnce(() => {
    started.resolve();
    return slow.promise;
  });
  state.bot.mockRejectedValueOnce(new Error("bot"));
  state.errors.mockReturnValueOnce(undefined);
  state.forget.mockReturnValueOnce(undefined);
  return Effect.gen(function* () {
    const cleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
    const fiber = yield* Effect.forkChild(cleanup.clear(EnvironmentId.make("env")));
    yield* Effect.promise(() => started.promise);
    expect(fiber.pollUnsafe()).toBeUndefined();
    slow.resolve();
    yield* Fiber.join(fiber);
    expect(state.errors).toHaveBeenCalledWith("env");
    expect(state.forget).toHaveBeenCalledWith("env");
    expect(warnings).toHaveLength(2);
  }).pipe(Effect.provide(Layer.merge(layerEnvironmentOwnedDataCleanup, logger)));
});

it.effect("times out a hung clear without preventing other clears", () => {
  const started = Promise.withResolvers<void>();
  const warnings: unknown[] = [];
  const logger = Logger.layer([Logger.make(({ message }) => warnings.push(message))], {
    mergeWithExisting: false,
  });
  state.outbox.mockImplementationOnce(() => {
    started.resolve();
    return new Promise<void>(() => {});
  });
  state.drafts.mockResolvedValueOnce(undefined);
  state.bot.mockResolvedValueOnce(undefined);
  state.errors.mockReturnValueOnce(undefined);
  state.forget.mockReturnValueOnce(undefined);
  return Effect.gen(function* () {
    const cleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
    const fiber = yield* Effect.forkChild(cleanup.clear(EnvironmentId.make("env-timeout")));
    yield* Effect.promise(() => started.promise);
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(fiber);
    expect(state.drafts).toHaveBeenCalledWith("env-timeout");
    expect(state.errors).toHaveBeenCalledWith("env-timeout");
    expect(warnings).toHaveLength(1);
  }).pipe(Effect.provide(Layer.merge(layerEnvironmentOwnedDataCleanup, logger)));
});
