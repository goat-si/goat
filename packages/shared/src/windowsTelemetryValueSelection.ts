export function windowsTelemetryValueSelectionCommand(valuesExpression: string): string {
  return `$values = @(${valuesExpression} | Where-Object { $_ -and $_.Trim() }); $value = $values | Where-Object { $_.Trim().ToLowerInvariant() -notin @('true','1','yes','on') } | Select-Object -First 1; if ($null -eq $value) { $value = $values | Select-Object -First 1 }`;
}
