import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

/**
 * A toolkit whose tools decode their arguments and encode their results as the JSON their MCP
 * schemas advertise.
 */
export const decodeAsAdvertised = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  // The clones keep each tool's id, name and decoded parameter type, so handlers still match.
  // Results encode as the JSON the output schema advertises: Effect puts the encoded value in
  // structuredContent, which must be JSON, so a DateTime left as a value fails it (#1368).
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      Tool.isDynamic(tool) && tool.jsonSchema !== undefined
        ? tool
        : tool
            .setParameters(Schema.toCodecJson(tool.parametersSchema))
            .setSuccess(Schema.toCodecJson(tool.successSchema)),
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;
