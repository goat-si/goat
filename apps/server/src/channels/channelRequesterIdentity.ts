import type { ChannelRequester } from "@goat/contracts";

export const sameRequester = (left: ChannelRequester, right: ChannelRequester) =>
  left.ownerId === right.ownerId && left.principalId === right.principalId;
