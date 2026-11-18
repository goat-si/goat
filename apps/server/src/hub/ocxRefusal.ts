/**
 * OpenCodex's own refusal for a link revoke or recover, read from the one "Error:" line its CLI
 * prints: the code, the hint when it names one from its closed set, and the outcome a journalled
 * revoke recorded. The CLI never prints the server's or the machine's text there.
 */
export interface OcxRefusal {
  readonly code: string;
  readonly hint?: string;
  readonly outcome?: string;
}

const CODE = "[a-z_]{1,64}";
const HINT = "[a-z0-9_-]{1,64}";
const RECOVER = new RegExp(
  `^Error: Link recover refused \\(\\d{3}\\): (${CODE})(?: \\((${HINT})\\))?(?::|$)`,
  "u",
);
const CODED = new RegExp(`\\(code (${CODE})(?:, hint (${HINT}))?\\)`, "u");
const OUTCOME = new RegExp(
  `^Error: Link revoke did not complete \\(operation [A-Za-z0-9._:-]{1,128}: (${CODE})\\)`,
  "u",
);

export const refusalOf = (stderr: string): OcxRefusal | undefined => {
  const line = stderr.split(/\r?\n/u).find((entry) => entry.startsWith("Error: "));
  if (line === undefined) return undefined;
  const recover = RECOVER.exec(line);
  if (recover?.[1] !== undefined)
    return { code: recover[1], ...(recover[2] === undefined ? {} : { hint: recover[2] }) };
  const coded = CODED.exec(line);
  if (coded?.[1] === undefined) return undefined;
  const outcome = OUTCOME.exec(line)?.[1];
  return {
    code: coded[1],
    ...(coded[2] === undefined ? {} : { hint: coded[2] }),
    ...(outcome === undefined ? {} : { outcome }),
  };
};
