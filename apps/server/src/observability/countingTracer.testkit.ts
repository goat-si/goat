import * as Tracer from "effect/Tracer";

/** Counts the spans a trace file records, sampled ones as they end, by name. */
export const countingTracer = (counts: Map<string, number>) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      if (!span.sampled) return span;
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        counts.set(options.name, (counts.get(options.name) ?? 0) + 1);
        end(endTime, exit);
      };
      return span;
    },
  });
