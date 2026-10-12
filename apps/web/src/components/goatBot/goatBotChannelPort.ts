import type {
  ChannelBotRef,
  ChannelEnsureBotInput,
  ChannelGetBotStatusResult,
  ChannelIngestInput,
  ChannelIngestResult,
  ChannelListTasksInput,
  ChannelListTasksResult,
  EnvironmentId,
} from "@t3tools/contracts";
import { createContext } from "react";

/**
 * Supplied by the channel transport once the server's channel RPCs are available.
 * Keep the installed port (including useCanSend's hook implementation) fixed for
 * the provider's lifetime. Port-consuming routes and the sidebar observer key
 * their session subtree by port presence, so installing/removing a port remounts
 * the injected hook. Replacing a non-null implementation also requires remounting
 * the provider; never swap hooks beneath mounted consumers.
 */
export interface GoatBotChannelPort {
  readonly ensureBot: (
    environmentId: EnvironmentId,
    input: ChannelEnsureBotInput,
  ) => Promise<ChannelBotRef>;
  /** Which thread is the bot and how many GOAT tasks wait; never creates the bot. */
  readonly getBotStatus: (environmentId: EnvironmentId) => Promise<ChannelGetBotStatusResult>;
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
