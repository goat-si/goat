import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import type * as AcpProtocol from "../protocol.ts";

export interface AcpBufferedRawNotification {
  readonly notification: AcpProtocol.AcpIncomingNotification;
  readonly lineLength: number;
}

const MAX_BUFFERED_RAW_NOTIFICATIONS = 32;
const MAX_BUFFERED_RAW_NOTIFICATION_JSON_LENGTH = 16 * 1024 * 1024;

export const makeBufferRawNotification = (
  rawNotifications: Queue.Queue<AcpBufferedRawNotification, Cause.Done<void>>,
) => {
  let rawNotificationsJsonLength = 0;
  return (notification: AcpProtocol.AcpIncomingNotification, lineLength: number) =>
    Effect.sync(() => {
      if (Queue.sizeUnsafe(rawNotifications) === 0) rawNotificationsJsonLength = 0;
      if (!Queue.offerUnsafe(rawNotifications, { notification, lineLength })) return;
      rawNotificationsJsonLength += lineLength;
      while (
        Queue.sizeUnsafe(rawNotifications) > MAX_BUFFERED_RAW_NOTIFICATIONS ||
        (Queue.sizeUnsafe(rawNotifications) > 1 &&
          rawNotificationsJsonLength > MAX_BUFFERED_RAW_NOTIFICATION_JSON_LENGTH)
      ) {
        const dropped = Queue.takeUnsafe(rawNotifications);
        if (dropped === undefined || Exit.isFailure(dropped)) break;
        rawNotificationsJsonLength -= dropped.value.lineLength;
      }
    });
};
