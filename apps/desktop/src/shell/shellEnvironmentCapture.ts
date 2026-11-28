// Lifted from GOAT v1 packages/shared/src/shellEnvironmentCapture.ts (origin/dev 916b5ccc1b2): verbatim except
// the Windows PowerShell builder (the Dev app is macOS only). Markers keep the __GOAT_ prefix.
import * as NodePath from "node:path";

const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const POSIX_PATH_DELIMITER = ":";

function envCaptureStart(name: string): string {
  return `__GOAT_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__GOAT_ENV_${name}_END__`;
}

const DEBUG_TRAP_SHELLS = new Set(["bash", "zsh", "sh", "ksh", "ksh93"]);
const POSIX_CAPTURE_SYNTAX = { assignment: "__GOAT_PRINTENV=$(", orElse: " || " };
const PRINTENV_CAPTURE_SYNTAX = new Map(
  [...DEBUG_TRAP_SHELLS, "dash", "ash"].map((shell) => [shell, POSIX_CAPTURE_SYNTAX] as const),
).set("fish", { assignment: "set -l __GOAT_PRINTENV (", orElse: "; or " });
// Network PATH entries must be probed inside the shell's deadline, away from the desktop thread.
const PRINTENV_LOOKUP_COMMAND = `/bin/sh -c 'command -v printenv || { [ -n "$1" ] && PATH="$1" command -v printenv; } || printf %s /usr/bin/printenv' goat`;

export function buildEnvironmentCaptureCommand(
  shell: string,
  names: ReadonlyArray<string>,
): string {
  const executableName = NodePath.basename(shell).toLowerCase();
  const isNushell = executableName.startsWith("nu");
  const syntax = PRINTENV_CAPTURE_SYNTAX.get(executableName);
  const supportsFallback = syntax !== undefined;
  const inheritedPath = (process.env.PATH ?? process.env.Path ?? process.env.path ?? "")
    .split(POSIX_PATH_DELIMITER)
    .filter(Boolean)
    .map((entry) => NodePath.posix.resolve(entry))
    .join(POSIX_PATH_DELIMITER);
  const lookupPrintenv = `${PRINTENV_LOOKUP_COMMAND} '${inheritedPath.replaceAll("'", "'\\''")}'`;
  const { assignment, orElse } = syntax ?? POSIX_CAPTURE_SYNTAX;
  const resolvePrintenv = `${assignment}${lookupPrintenv}); `;

  const capture = names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      if (isNushell) {
        // Without a configured conversion, Nu expands home paths only in a list PATH.
        const defaultValue =
          name === "PATH"
            ? "if ($env.PATH? | describe | str starts-with 'list') { " +
              "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
              "$p | path expand --no-symlink } else { $p } } | str join (char esep) " +
              "} else { $env.PATH? | default '' }"
            : `$env.${name}? | default ''`;
        const value =
          `if $env.${name}? == null { '' } else if ` +
          `$env.ENV_CONVERSIONS?.${name}?.to_string? != null { ` +
          `$env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} ` +
          `} else { ${defaultValue} }`;
        return [
          `print '${envCaptureStart(name)}'`,
          `print (${value})`,
          `print '${envCaptureEnd(name)}'`,
        ].join("; ");
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        supportsFallback
          ? `printenv ${name}${orElse}"$__GOAT_PRINTENV" ${name}${orElse}true`
          : `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");

  // A DEBUG trap that echoes each command (e.g. into the terminal title) would print the markers.
  // OpenBSD ksh (also its /bin/sh) exits on `trap - DEBUG`, so try it in a subshell first.
  const command = supportsFallback ? resolvePrintenv + capture : capture;
  return DEBUG_TRAP_SHELLS.has(executableName)
    ? `(trap - DEBUG) 2>/dev/null && trap - DEBUG; ${command}`
    : command;
}

export function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  const value = output
    .slice(valueStartIndex, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

  return value.length > 0 ? value : undefined;
}

export function extractEnvironmentValues(output: string, names: ReadonlyArray<string>) {
  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
