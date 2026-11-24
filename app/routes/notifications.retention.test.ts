import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withDatabase } from "~/db";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { purgeExpiredNotifications } from "~/lib/notification-retention.server";
import { action, loader } from "./api.notifications";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
const boundary = new Date("2026-11-24T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(boundary);
  db = createTestDb();
  base = seedBaseData(db);
});
afterEach(() => {
  db.$client.close();
  vi.useRealTimers();
});

function entry(
  kind: schema.NotificationKind,
  createdAt = "2026-08-26T12:00:00.000Z"
) {
  const isRefund =
    kind !== schema.NotificationKind.LessonQuestion &&
    kind !== schema.NotificationKind.LessonReply;
  let refundId: number | undefined;
  if (isRefund) {
    if (kind === schema.NotificationKind.RefundSubmitted) {
      db.update(schema.users)
        .set({ role: schema.UserRole.Admin })
        .where(eq(schema.users.id, base.user.id))
        .run();
    }
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId:
          kind === schema.NotificationKind.RefundSubmitted
            ? base.instructor.id
            : base.user.id,
        courseId: base.course.id,
        amountPaid: 5000,
      })
      .returning()
      .get();
    refundId = db
      .insert(schema.refunds)
      .values({
        purchaseId: purchase.id,
        reason: "Not for me",
        status:
          kind === schema.NotificationKind.RefundApproved
            ? schema.RefundStatus.Approved
            : kind === schema.NotificationKind.RefundDeclined
              ? schema.RefundStatus.Declined
              : schema.RefundStatus.Open,
      })
      .returning()
      .get().id;
  }
  return db
    .insert(schema.notifications)
    .values({
      recipientId: base.user.id,
      eventKey: `${kind}:${createdAt}`,
      kind,
      refundId,
      createdAt,
    })
    .returning()
    .get();
}

async function inbox() {
  const cookie = await setCurrentUserId(
    new Request("http://localhost"),
    base.user.id
  );
  return withDatabase(db, () =>
    loader({
      request: new Request("http://localhost/api/notifications", {
        headers: { Cookie: cookie },
      }),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0])
  );
}

async function mutate(intent: string, id?: number) {
  const cookie = await setCurrentUserId(
    new Request("http://localhost"),
    base.user.id
  );
  return withDatabase(db, () =>
    action({
      request: new Request("http://localhost/api/notifications", {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({
          intent,
          ...(id === undefined ? {} : { id: String(id) }),
        }),
      }),
      params: {},
      context: {},
    } as Parameters<typeof action>[0])
  );
}

it.each([
  schema.NotificationKind.LessonQuestion,
  schema.NotificationKind.LessonReply,
  schema.NotificationKind.RefundSubmitted,
  schema.NotificationKind.RefundReceipt,
  schema.NotificationKind.RefundApproved,
  schema.NotificationKind.RefundDeclined,
])("expires %s at exactly 90 days before physical deletion", async (kind) => {
  const expired = entry(kind);
  const younger = entry(kind, "2026-08-26T12:00:00.001Z");
  vi.setSystemTime(new Date("2026-11-24T11:59:59.999Z"));
  expect((await inbox()).items.map((item) => item.id)).toEqual([
    younger.id,
    expired.id,
  ]);
  expect((await inbox()).unreadCount).toBe(2);
  vi.setSystemTime(boundary);
  const result = await inbox();
  expect(result.items.map((item) => item.id)).toEqual([younger.id]);
  expect(
    result.items.filter((item) => item.readAt === null).map((item) => item.id)
  ).toEqual([younger.id]);
  expect(result.unreadCount).toBe(1);
  if (younger.refundId !== null) {
    const path =
      kind === schema.NotificationKind.RefundSubmitted
        ? "/admin/refunds"
        : "/settings";
    expect(result.items[0]?.destination).toBe(
      `${path}?refundRequestId=${younger.refundId}#refund-request-${younger.refundId}`
    );
  }
  expect(db.select().from(schema.notifications).all()).toHaveLength(2);
});

it("rejects every individual mutation for expired entries and leaves them untouched by mark-all", async () => {
  const expired = entry(schema.NotificationKind.LessonQuestion);
  const younger = entry(
    schema.NotificationKind.LessonQuestion,
    "2026-08-26T12:00:00.001Z"
  );
  for (const intent of ["read", "unread", "open"]) {
    await expect(mutate(intent, expired.id)).rejects.toMatchObject({
      init: { status: 404 },
    });
  }
  await mutate("mark-all");
  expect(
    db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, expired.id))
      .get()?.readAt
  ).toBeNull();
  expect((await inbox()).items).toMatchObject([
    { id: younger.id, readAt: boundary.toISOString() },
  ]);
  expect((await inbox()).unreadCount).toBe(0);
});

it("purges every expired kind, preserves younger rows and is repeatable", async () => {
  for (const kind of [
    schema.NotificationKind.LessonQuestion,
    schema.NotificationKind.LessonReply,
    schema.NotificationKind.RefundSubmitted,
    schema.NotificationKind.RefundReceipt,
    schema.NotificationKind.RefundApproved,
    schema.NotificationKind.RefundDeclined,
  ])
    entry(kind);
  const younger = entry(
    schema.NotificationKind.LessonQuestion,
    "2026-08-26T12:00:00.001Z"
  );
  expect(withDatabase(db, () => purgeExpiredNotifications())).toBe(6);
  expect(db.select().from(schema.notifications).all()).toMatchObject([
    { id: younger.id },
  ]);
  expect(withDatabase(db, () => purgeExpiredNotifications())).toBe(0);
  expect((await inbox()).items.map((item) => item.id)).toEqual([younger.id]);
});

it("removes an account's inbox through the recipient cascade without deleting another account's history", async () => {
  entry(schema.NotificationKind.LessonQuestion);
  const other = db
    .insert(schema.notifications)
    .values({
      recipientId: base.instructor.id,
      actorId: base.user.id,
      kind: schema.NotificationKind.LessonQuestion,
      eventKey: "other-account",
    })
    .returning()
    .get();
  // Existing domain references must be handled by a future account-removal transaction.
  db.delete(schema.users).where(eq(schema.users.id, base.user.id)).run();
  expect(db.select().from(schema.notifications).all()).toMatchObject([
    { id: other.id, actorId: null },
  ]);
  expect(db.select().from(schema.notifications).all()).toHaveLength(1);
});
