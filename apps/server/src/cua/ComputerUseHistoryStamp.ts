let sequence = 0;

export const historyStamp = (recordedAt: number) => ({ recordedAt, orderSeq: ++sequence });
export type HistoryStamp = ReturnType<typeof historyStamp>;
