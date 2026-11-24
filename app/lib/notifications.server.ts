import { and, desc, eq } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  courses,
  lessons,
  modules,
  notifications,
  refunds,
  purchases,
  UserRole,
  users,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { activeInbox } from "~/lib/notification-retention.server";
import { getAccess } from "~/lib/access.server";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Call within the domain transaction. Re-emission preserves existing read state. */
export function insertNotifications(
  tx: Transaction,
  entries: (typeof notifications.$inferInsert)[]
) {
  if (entries.length)
    tx.insert(notifications)
      .values(entries)
      .onConflictDoNothing({
        target: [notifications.eventKey, notifications.recipientId],
      })
      .run();
}

export async function presentNotification(
  request: Request,
  item: typeof notifications.$inferSelect
) {
  if (item.kind.startsWith("refund_")) {
    const userId = await getCurrentUserId(request);
    const user = userId
      ? db.select().from(users).where(eq(users.id, userId)).get()
      : undefined;
    const target =
      item.refundId === null
        ? undefined
        : db
            .select({ refund: refunds, purchase: purchases, course: courses })
            .from(refunds)
            .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
            .innerJoin(courses, eq(purchases.courseId, courses.id))
            .where(eq(refunds.id, item.refundId))
            .get();
    const review = item.kind === "refund_submitted";
    if (
      target &&
      user &&
      user.id === item.recipientId &&
      (review
        ? user.role === UserRole.Admin
        : target.purchase.userId === user.id)
    ) {
      const actor =
        item.actorId === null
          ? undefined
          : db.select().from(users).where(eq(users.id, item.actorId)).get();
      return {
        id: item.id,
        createdAt: item.createdAt,
        readAt: item.readAt,
        title: review
          ? `${actor?.name ?? "Someone"} submitted a Refund Request`
          : item.kind === "refund_approved"
            ? "Refund Request approved"
            : item.kind === "refund_declined"
              ? "Refund Request declined"
              : "Refund Request received",
        context: `${target.course.title} · Purchase #${target.purchase.id}`,
        destination: `${review ? "/admin/refunds" : "/settings"}?refundRequestId=${target.refund.id}#refund-request-${target.refund.id}`,
      };
    }
    return {
      id: item.id,
      createdAt: item.createdAt,
      readAt: item.readAt,
      title: "Notification unavailable",
      context: null,
      destination: null,
    };
  }
  const target =
    item.commentId === null
      ? undefined
      : db
          .select({
            comment: comments,
            lesson: lessons,
            course: courses,
          })
          .from(comments)
          .innerJoin(lessons, eq(comments.lessonId, lessons.id))
          .innerJoin(modules, eq(lessons.moduleId, modules.id))
          .innerJoin(courses, eq(modules.courseId, courses.id))
          .where(eq(comments.id, item.commentId))
          .get();
  if (
    !target ||
    target.comment.deletedAt ||
    !(await getAccess(request, target.course.id)).canViewContent
  ) {
    return {
      id: item.id,
      createdAt: item.createdAt,
      readAt: item.readAt,
      title: "Notification unavailable",
      context: null,
      destination: null,
    };
  }
  const actor =
    item.actorId === null
      ? undefined
      : db.select().from(users).where(eq(users.id, item.actorId)).get();
  return {
    id: item.id,
    createdAt: item.createdAt,
    readAt: item.readAt,
    title: `${actor?.name ?? "Someone"} ${item.kind === "lesson-reply" ? "replied to a question" : "asked a question"}`,
    context: `${target.course.title} · ${target.lesson.title}`,
    destination: `/courses/${target.course.slug}/lessons/${target.lesson.id}#comment-${target.comment.id}`,
  };
}

export async function getInbox(request: Request, recipientId: number) {
  const rows = db
    .select()
    .from(notifications)
    .where(activeInbox(recipientId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .all();
  return {
    items: await Promise.all(
      rows.map((row) => presentNotification(request, row))
    ),
    unreadCount: rows.filter((row) => row.readAt === null).length,
  };
}

export function recipientNotification(id: number, recipientId: number) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), activeInbox(recipientId)))
    .get();
}
