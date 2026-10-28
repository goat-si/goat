import * as Tracer from "effect/Tracer";

/** Counts finished spans by name, so a test can tell repeated work from settled work. */
export const countingTracer = (counts: Map<string, number>) =>
  Tracer.make({
    span: (options) => {
      counts.set(options.name, (counts.get(options.name) ?? 0) + 1);
      return new Tracer.NativeSpan(options);
    },
  });
