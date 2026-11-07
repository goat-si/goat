export function claudeStructuredErrorCases(apiError: string) {
  const error = "Failed to provide valid structured output after 5 attempts";
  const failure = {
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
    errors: [error],
  };
  return [
    ["the errors list of a result with no result text", JSON.stringify(failure), error],
    [
      "the errors list from verbose output",
      JSON.stringify([{ type: "system", subtype: "init" }, failure]),
      error,
    ],
    [
      "the errors list without CLI telemetry",
      JSON.stringify({
        ...failure,
        subtype: "error_during_execution",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a", apiError],
      }),
      apiError,
    ],
    ["the errors list with empty stderr", JSON.stringify(failure), error, ""],
  ] as const;
}
