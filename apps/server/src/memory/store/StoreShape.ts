import type { RecallStore } from "./Recall.ts";
import type { LocalStoreShape } from "./LocalStoreShape.ts";
import type { SyncStoreShape } from "./SyncStoreShape.ts";

import type { FloorWriteStore } from "./FloorWrites.ts";
import type { HubFloorStore } from "./HubFloor.ts";

export interface MemoryStoreShape
  extends LocalStoreShape, SyncStoreShape, RecallStore, HubFloorStore, FloorWriteStore {}
