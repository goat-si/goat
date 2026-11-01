import type { DecisionItem } from "@goat/contracts";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// SQL limits each source before merging; ties must use its binary ordering, not locale or URI order.
export const compareDecisions = (a: DecisionItem, b: DecisionItem) =>
  compare(b.createdAt, a.createdAt) ||
  compare(a.source, b.source) ||
  (a.source === "pending_request" && b.source === "pending_request"
    ? compare(a.pending?.threadId ?? a.id, b.pending?.threadId ?? b.id) ||
      compare(a.pending?.requestId ?? a.id, b.pending?.requestId ?? b.id)
    : compare(a.id, b.id)) ||
  compare(a.from.environmentId ?? "", b.from.environmentId ?? "") ||
  compare(a.from.host ?? "", b.from.host ?? "");
