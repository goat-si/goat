import type {
  ChannelBotRef,
  ChannelEnsureBotInput,
  ChannelIngestInput,
  ChannelIngestResult,
  ChannelListTasksInput,
  ChannelListTasksResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { createContext } from "react";

/** Supplied by the channel transport once the server's channel RPCs are available. */
export interface GoatBotChannelPort {
  readonly ensureBot: (
    environmentId: EnvironmentId,
    input: ChannelEnsureBotInput,
  ) => Promise<ChannelBotRef>;
  readonly ingest: (
    environmentId: EnvironmentId,
    input: ChannelIngestInput,
  ) => Promise<ChannelIngestResult>;
  readonly listTasks: (
    environmentId: EnvironmentId,
    input: ChannelListTasksInput,
  ) => Promise<ChannelListTasksResult>;
  readonly useCanSend: (environmentId: EnvironmentId | null) => boolean;
}

export const GoatBotChannelContext = createContext<GoatBotChannelPort | null>(null);
