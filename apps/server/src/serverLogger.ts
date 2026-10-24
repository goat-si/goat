import * as HostProcess from "@goat/shared/HostProcess";
import * as SharedObservability from "@goat/shared/observability";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpLogger from "effect/observability/OtlpLogger";

import * as ServerConfig from "./config.ts";
import * as LogRedaction from "./observability/LogRedaction.ts";

export const layer = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const hostName = yield* HostProcess.Hostname;
  const layerMinimumLogLevel = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  const logs = config.otlpLogsExport;
  const otlpLogger =
    config.otlpLogsUrl === undefined
      ? undefined
      : OtlpLogger.make({
          url: config.otlpLogsUrl,
          exportInterval: `${logs.exportIntervalMs} millis`,
          headers: logs.headers,
          resource: ServerConfig.otlpResource(config, hostName),
        });

  // `Logger.layer` writes the whole logger set rather than adding to it, so
  // every logger the server wants has to be named in this one call.
  // `Logger.tracerLogger` reaches a collector by attaching each message to the
  // active span as a span event, which covers only messages logged inside a
  // recorded span and files them under traces. The OTLP logger carries the same
  // messages as log records stamped with their trace and span ids, so it is a
  // superset: keeping both would export every in-span message twice.
  // Every sink is wrapped so credentials never reach it (#1388); the wrapper also prints a Cause
  // passed as a field as Cause.pretty text, which util.inspect would collapse to [Object].
  const consoleLogger = LogRedaction.redacting(Logger.consolePretty());
  const layerLogger = Logger.layer(
    otlpLogger === undefined
      ? [consoleLogger, LogRedaction.redacting(Logger.tracerLogger)]
      : [consoleLogger, LogRedaction.redactingEffect(otlpLogger)],
    { mergeWithExisting: false },
  ).pipe(
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(SharedObservability.layerOtlpSerialization(logs.protocol)),
  );

  return Layer.mergeAll(layerLogger, layerMinimumLogLevel);
}).pipe(Layer.unwrap);
