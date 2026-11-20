import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import {
  makePublishedBackgroundBudget,
  PUBLISHED_BACKGROUND_MAX_BYTES,
} from "./publishedBackgroundBudget.ts";

it.effect("admits two full backgrounds, refuses a third and releases on scoped cancellation", () =>
  Effect.gen(function* () {
    const budget = makePublishedBackgroundBudget();
    const first = yield* Scope.make();
    const second = yield* Scope.make();
    const third = yield* Scope.make();
    expect(
      yield* budget
        .reserve(PUBLISHED_BACKGROUND_MAX_BYTES)
        .pipe(Effect.provideService(Scope.Scope, first)),
    ).not.toBeNull();
    expect(
      yield* budget
        .reserve(PUBLISHED_BACKGROUND_MAX_BYTES)
        .pipe(Effect.provideService(Scope.Scope, second)),
    ).not.toBeNull();
    expect(
      yield* budget
        .reserve(PUBLISHED_BACKGROUND_MAX_BYTES)
        .pipe(Effect.provideService(Scope.Scope, third)),
    ).toBeNull();
    expect(budget.inFlightBytes()).toBe(2 * PUBLISHED_BACKGROUND_MAX_BYTES);
    yield* Scope.close(first, Exit.interrupt());
    expect(budget.inFlightBytes()).toBe(PUBLISHED_BACKGROUND_MAX_BYTES);
    expect(
      yield* budget
        .reserve(PUBLISHED_BACKGROUND_MAX_BYTES)
        .pipe(Effect.provideService(Scope.Scope, third)),
    ).not.toBeNull();
    yield* Scope.close(second, Exit.void);
    yield* Scope.close(third, Exit.void);
    expect(budget.inFlightBytes()).toBe(0);
  }),
);
