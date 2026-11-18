import { legacyEnvName } from "@goat/contracts/legacyT3Names";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
export function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

const unquoteSystemdValue = (raw: string) =>
  (raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : raw
  ).replaceAll("%%", "%");

const unescapeXmlText = (value: string) =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// Units carry both spellings of the home; builds before the GOAT rename wrote only the legacy one.
const HOME_NAMES = ["GOAT_HOME", legacyEnvName("GOAT_HOME") ?? "GOAT_HOME"].join("|");

/** The GOAT home a unit or plist serves. */
export function bootServiceBaseDirOf(contents: string): string | undefined {
  const systemd = new RegExp(`^Environment=(?:${HOME_NAMES})=(.*)$`, "m").exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd.trim());
  const plist = new RegExp(`<key>(?:${HOME_NAMES})</key>\\s*<string>([^<]*)</string>`).exec(
    contents,
  )?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

/** The file systemd or launchd appends the service's output to. */
export function serviceUnitLogPathOf(contents: string): string | undefined {
  const systemd = /^StandardOutput=append:(.*)$/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd.trim());
  const plist = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

/** The executable an installed unit or plist starts: the launcher's runtime. */
export function bootServiceProgramOf(contents: string): string | undefined {
  const systemd = /^ExecStart=("(?:\\.|[^"\\])*"|\S+)/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd);
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
    contents,
  )?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}
