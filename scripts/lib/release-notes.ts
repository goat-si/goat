export const RELEASE_SIGNING_NOTICE =
  "macOS: signed and notarized (Developer ID, team U9ATA49N28). Windows and Linux: unsigned in this stage — verify downloads with SHA256SUMS.";

function platformOfFile(name: string) {
  if (/^goat-.*-(darwin|win32|linux)-(arm64|x64)\.(zip|tar\.gz)$/.test(name)) return "cli";
  // Desktop ZIPs are macOS-only; CLI archives are classified above.
  if (/mac|darwin|\.(dmg|zip)(?:\.blockmap)?$/i.test(name)) return "mac";
  if (/win|\.exe(?:\.blockmap)?$|^(?:nightly|latest)\.yml$/i.test(name)) return "win";
  if (/linux|\.(AppImage|deb)(?:\.blockmap)?$/i.test(name)) return "linux";
  return "other";
}

/** Public notes describe downloads and signing, without private source history. */
export function renderReleaseNotes(version: string, utcDate: string, files: ReadonlyArray<string>) {
  const sortedFiles = files.toSorted();
  const rows = ["mac", "win", "linux", "cli", "other"].flatMap((platform) =>
    sortedFiles
      .filter((file) => platformOfFile(file) === platform)
      .map((file) => `| ${platform} | \`${file.replaceAll("|", "\\|").replaceAll("`", "")}\` |`),
  );
  return [
    `GOAT ${version}`,
    "",
    `UTC date: ${utcDate}`,
    "",
    "| Platform | File |",
    "| --- | --- |",
    ...rows,
    "",
    RELEASE_SIGNING_NOTICE,
    "",
  ].join("\n");
}
