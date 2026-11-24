import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withDatabase } from "~/db";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { action as submit } from "./courses.$slug.refund";
import { loader as inbox } from "./api.notifications";
import { loader as buyerDestination } from "./settings";
import { loader as reviewDestination } from "./admin.refunds";

const mail = vi.hoisted(() => ({ send: vi.fn(async () => {}) }));
vi.mock("~/lib/mailer.server", () => ({ sendEmail: mail.send }));
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let purchase: typeof schema.purchases.$inferSelect;
let admin: typeof schema.users.$inferSelect;
beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  mail.send.mockReset();
  admin = db
    .insert(schema.users)
    .values({
      name: "Platform Admin",
      email: "admin@test.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
  purchase = db
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 5000,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
});
afterEach(() => db.$client.close());
async function request(
  userId: number | null,
  path = "/",
  fields?: Record<string, string>
) {
  const headers = new Headers();
  if (userId !== null)
    headers.set(
      "Cookie",
      await setCurrentUserId(new Request("http://localhost"), userId)
    );
  return new Request(`http://localhost${path}`, {
    headers,
    ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
  });
}
async function raise(userId: number | null = base.user.id) {
  const req = await request(userId, "/", {
    purchaseId: String(purchase.id),
    reason: "This course is not for me",
  });
  return withDatabase(db, () =>
    submit({
      request: req,
      params: { slug: base.course.slug },
      context: {},
    } as Parameters<typeof submit>[0])
  );
}
async function read(userId: number) {
  const req = await request(userId);
  return withDatabase(db, () =>
    inbox({ request: req, params: {}, context: {} } as Parameters<
      typeof inbox
    >[0])
  );
}
it("atomically gives the buyer a receipt and every current Platform Admin a review alert", async () => {
  await raise();
  expect((await read(base.user.id)).items).toMatchObject([
    {
      title: "Refund Request received",
      context: "Test Course · Purchase #1",
      destination: "/settings?refundRequestId=1#refund-request-1",
    },
  ]);
  expect((await read(admin.id)).items).toMatchObject([
    {
      title: "Test User submitted a Refund Request",
      destination: "/admin/refunds?refundRequestId=1#refund-request-1",
    },
  ]);
  expect(mail.send).toHaveBeenCalledTimes(1);
});

it("rolls back every recipient and the Refund Request after a partial inbox failure, then retries", async () => {
  db.$client.exec(
    `CREATE TRIGGER fail_receipt BEFORE INSERT ON notifications WHEN NEW.recipient_id = ${base.user.id} BEGIN SELECT RAISE(FAIL, 'Inbox failure'); END`
  );
  await expect(raise()).rejects.toThrow("Inbox failure");
  expect((await read(admin.id)).items).toEqual([]);
  expect(db.select().from(schema.refunds).all()).toEqual([]);
  expect(mail.send).not.toHaveBeenCalled();
  db.$client.exec("DROP TRIGGER fail_receipt");
  await raise();
  expect((await read(admin.id)).unreadCount).toBe(1);
  expect((await read(base.user.id)).unreadCount).toBe(1);
});
it("keeps a Platform Admin buyer's receipt and resolves later recipients at event time", async () => {
  db.update(schema.users)
    .set({ role: schema.UserRole.Admin })
    .where(eq(schema.users.id, base.user.id))
    .run();
  await raise();
  expect((await read(base.user.id)).items).toMatchObject([
    { title: "Refund Request received" },
  ]);
  db.update(schema.users)
    .set({ role: schema.UserRole.Student })
    .where(eq(schema.users.id, admin.id))
    .run();
  expect((await read(admin.id)).items).toMatchObject([
    { title: "Notification unavailable", context: null, destination: null },
  ]);
  db.update(schema.refunds).set({ status: schema.RefundStatus.Declined }).run();
  await raise();
  expect((await read(admin.id)).items).toHaveLength(1);
  expect((await read(base.user.id)).items).toHaveLength(2);
});
it("preserves committed requests and entries if the existing post-commit email fails", async () => {
  mail.send.mockRejectedValueOnce(new Error("Email unavailable"));
  await expect(raise()).rejects.toThrow("Email unavailable");
  expect((await read(admin.id)).unreadCount).toBe(1);
  expect((await read(base.user.id)).unreadCount).toBe(1);
  await expect(raise()).rejects.toMatchObject({ init: { status: 409 } });
  expect(mail.send).toHaveBeenCalledTimes(1);
});
async function destination(userId: number | null, review = false, id = 1) {
  const req = await request(
    userId,
    `${review ? "/admin/refunds" : "/settings"}?refundRequestId=${id}`
  );
  return withDatabase(db, () =>
    review
      ? reviewDestination({
          request: req,
          params: {},
          context: {},
        } as Parameters<typeof reviewDestination>[0])
      : buyerDestination({
          request: req,
          params: {},
          context: {},
        } as Parameters<typeof buyerDestination>[0])
  );
}
it("opens the selected Team Licence request without Enrollment and follows its current decision status", async () => {
  const team = db.insert(schema.teams).values({}).returning().get();
  db.insert(schema.coupons)
    .values({
      teamId: team.id,
      code: "TEAM-SEAT",
      purchaseId: purchase.id,
      courseId: base.course.id,
    })
    .run();
  await raise();
  db.update(schema.refunds).set({ status: schema.RefundStatus.Approved }).run();
  expect(await destination(base.user.id)).toMatchObject({
    selectedRefundRequestId: 1,
    refundRequests: [{ id: 1, status: "approved" }],
  });
  expect(await destination(admin.id, true)).toMatchObject({
    selectedRefundRequestId: 1,
    status: "approved",
    refundRequests: [{ id: 1 }],
  });
  await expect(destination(admin.id)).rejects.toMatchObject({
    init: { status: 404 },
  });
  await expect(destination(base.user.id, true)).rejects.toMatchObject({
    init: { status: 403 },
  });
  await expect(destination(null)).rejects.toMatchObject({
    init: { status: 401 },
  });
  db.update(schema.users)
    .set({ role: schema.UserRole.Student })
    .where(eq(schema.users.id, admin.id))
    .run();
  await expect(destination(admin.id, true)).rejects.toMatchObject({
    init: { status: 403 },
  });
});

it("alerts every Platform Admin and uses current membership only for later submissions", async () => {
  const second = db
    .insert(schema.users)
    .values({
      name: "Second Admin",
      email: "second@test.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
  await raise();
  expect((await read(second.id)).unreadCount).toBe(1);
  db.update(schema.users)
    .set({ role: schema.UserRole.Admin })
    .where(eq(schema.users.id, base.instructor.id))
    .run();
  expect((await read(base.instructor.id)).items).toEqual([]);
  db.update(schema.refunds).set({ status: schema.RefundStatus.Declined }).run();
  await raise();
  expect((await read(admin.id)).items).toHaveLength(2);
  expect((await read(second.id)).items).toHaveLength(2);
  expect((await read(base.instructor.id)).items).toHaveLength(1);
});
it("rejects another buyer and a duplicate Open Refund Request without entries or extra email", async () => {
  await expect(raise(admin.id)).rejects.toMatchObject({
    init: { status: 404 },
  });
  expect((await read(admin.id)).items).toEqual([]);
  expect(mail.send).not.toHaveBeenCalled();
  await raise();
  await expect(raise()).rejects.toMatchObject({ init: { status: 409 } });
  expect((await read(base.user.id)).items).toHaveLength(1);
  expect((await read(admin.id)).items).toHaveLength(1);
  expect(mail.send).toHaveBeenCalledTimes(1);
});
it("genericizes removed requests and changed Purchase ownership without granting direct buyer access", async () => {
  await raise();
  db.update(schema.purchases)
    .set({ userId: admin.id })
    .where(eq(schema.purchases.id, purchase.id))
    .run();
  expect((await read(base.user.id)).items).toMatchObject([
    { title: "Notification unavailable", context: null, destination: null },
  ]);
  await expect(destination(base.user.id)).rejects.toMatchObject({
    init: { status: 404 },
  });
  db.delete(schema.refunds).run();
  expect((await read(admin.id)).items).toMatchObject([
    { title: "Notification unavailable", context: null, destination: null },
  ]);
  await expect(destination(admin.id, true)).rejects.toMatchObject({
    init: { status: 404 },
  });
});

it("authenticates submission directly without creating a request or sending email", async () => {
  await expect(raise(null)).rejects.toMatchObject({ init: { status: 401 } });
  expect(db.select().from(schema.refunds).all()).toEqual([]);
  expect((await read(admin.id)).items).toEqual([]);
  expect(mail.send).not.toHaveBeenCalled();
});
