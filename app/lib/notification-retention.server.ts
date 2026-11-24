import { and, eq, gt, lte } from "drizzle-orm";
import { db } from "~/db";
import { notifications } from "~/db/schema";

const retentionMilliseconds = 90 * 24 * 60 * 60 * 1000;

function expiryCutoff(now: Date) {
  return new Date(now.getTime() - retentionMilliseconds).toISOString();
}

/** Shared by every inbox kind, read/count query and mutation. */
export function activeInbox(recipientId: number, now = new Date()) {
  return and(
    eq(notifications.recipientId, recipientId),
    gt(notifications.createdAt, expiryCutoff(now))
  );
}

/** Daily maintenance entry point; safe to repeat after an interrupted run. */
export function purgeExpiredNotifications(now = new Date()) {
  return db
    .delete(notifications)
    .where(lte(notifications.createdAt, expiryCutoff(now)))
    .run().changes;
}
