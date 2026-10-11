import type { ThirdPartyLicenseManifest } from "./third-party-licenses.ts";

/**
 * Renders the web build's third-party-licenses.json as the THIRD_PARTY_NOTICES.md
 * that goat-releases publishes beside every nightly. Entries are sorted so the
 * file only changes when a dependency or its notice changes.
 */
export function renderThirdPartyNotices(manifest: ThirdPartyLicenseManifest): string {
  const entries = [...manifest.entries].toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      (left.version ?? "").localeCompare(right.version ?? ""),
  );
  const sections = entries.map((entry) => {
    const title = entry.version ? `${entry.name} ${entry.version}` : entry.name;
    const source = entry.sourceUrl ? `\n\nSource: ${entry.sourceUrl}` : "";
    const notice = entry.noticeText.trim().replaceAll("```", "``\u200b`");
    return `## ${title}\n\nLicense: ${entry.license}${source}\n\n\`\`\`text\n${notice}\n\`\`\``;
  });
  return [
    "# Third-party notices",
    "",
    "GOAT includes the software listed below. GOAT is based on T3 Code; its MIT notice is in LICENSE-T3CODE.txt.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}
