/** Score the issued ticket separately from what the memory service supplied. */
export function scoreTicket(
  answer: string,
  expected: { current: string; previous: string; currentSupplied: boolean },
) {
  let ticket: unknown;
  try {
    ticket = JSON.parse(answer);
  } catch {
    return "invalid-ticket";
  }
  if (
    !ticket ||
    typeof ticket !== "object" ||
    !("acceptanceCode" in ticket) ||
    Object.keys(ticket).length !== 1
  )
    return "invalid-ticket";
  const code = ticket.acceptanceCode;
  if (code === null) return expected.currentSupplied ? "missed-current" : "abstained";
  if (code === expected.previous) return "stale";
  if (code === expected.current)
    return expected.currentSupplied ? "grounded-current" : "unsupported-current";
  return typeof code === "string" ? "wrong-code" : "invalid-ticket";
}
