/**
 * src/consumers/notification.consumer.js
 *
 * Handles notification_requested events.
 * For now: logs the notification intent. In production, this would
 * send SMS/email/push via the appropriate channel.
 */

"use strict";

function createNotificationConsumer({ prisma, emitPvHook }) {
  return async function handleNotification(event) {
    const payload = event.payloadJson || {};

    emitPvHook("consumer.notification.processed", {
      tc: "TC-CON-01",
      sev: "info",
      stable: "consumer:notification:" + event.eventId,
      eventId: event.eventId,
      eventType: event.eventType,
      consumerId: event.consumerId,
      merchantId: event.merchantId,
      channel: payload.channel || "log",
    });

    // TODO: In production, dispatch to SMS/email/push service
    // For now, just log the notification intent
    console.log("[notification.consumer] processed:", event.eventType, "consumer:", event.consumerId);

    return { notified: true, channel: payload.channel || "log" };
  };
}

module.exports = { createNotificationConsumer };
