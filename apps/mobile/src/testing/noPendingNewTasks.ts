/** A use-pending-new-tasks stand-in with no pending tasks and no launches in flight. */
// oxlint-disable-next-line goat/no-hookless-use-function -- stands in for the module's hook in vi.mock
export const usePendingNewTasks = () => [];

// oxlint-disable-next-line goat/no-hookless-use-function -- stands in for the module's hook in vi.mock
export const useLaunchingThreads = <T>(threads: T): T => threads;
