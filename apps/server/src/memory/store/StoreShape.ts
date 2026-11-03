import type { RecallStore } from "./Recall.ts";
import type { LocalStoreShape } from "./LocalStoreShape.ts";
import type { SyncStoreShape } from "./SyncStoreShape.ts";

export interface MemoryStoreShape extends LocalStoreShape, SyncStoreShape, RecallStore {}
