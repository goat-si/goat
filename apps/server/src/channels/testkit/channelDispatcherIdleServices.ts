import * as Layer from "effect/Layer";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ChannelChildWork from "../ChannelChildWork.ts";
import * as ChannelRemoteWorkers from "../ChannelRemoteWorkers.ts";
import * as SlackChannelSettings from "../SlackChannelSettings.ts";

/**
 * Services ChannelDispatcher.layer requires that a test driving only its local forward path never
 * calls. A new dispatcher dependency of that kind belongs here, so callers outside the channels
 * module do not each grow a mock for it.
 */
export const channelDispatcherIdleServices = Layer.mergeAll(
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ChannelChildWork.ChannelChildWork)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ChannelRemoteWorkers.ChannelRemoteWorkers)({}),
  Layer.mock(SlackChannelSettings.SlackChannelSettings)({}),
);
