export function windowsTelemetryValueSelectionCommand(valuesExpression: string): string {
  return `$values = @(${valuesExpression} | Where-Object { $_ -and $_.Trim() }); $value = $values | Where-Object { $_.Trim().ToLowerInvariant() -notin @('true','1','yes','on') } | Select-Object -First 1; if ($null -eq $value) { $value = $values | Select-Object -First 1 }`;
}

// A variable saved after this process started is only in the User or Machine registry scope.
export function windowsEnvironmentValueCommand(name: string): string {
  if (name === "PATH") return "$value = [Environment]::GetEnvironmentVariable('PATH')";
  const values =
    "@(" +
    `[Environment]::GetEnvironmentVariable('${name}','Process'),` +
    `[Environment]::GetEnvironmentVariable('${name}','User'),` +
    `[Environment]::GetEnvironmentVariable('${name}','Machine')` +
    ") | Where-Object { $_ }";
  if (
    [
      "GOAT_TELEMETRY_ENABLED",
      "T3CODE_TELEMETRY_ENABLED", // goat-rename: legacy
    ].includes(name)
  ) {
    // Any explicit opt-out must win over an inherited opt-in.
    return windowsTelemetryValueSelectionCommand(values);
  }
  return `$value = ${values} | Select-Object -First 1`;
}
