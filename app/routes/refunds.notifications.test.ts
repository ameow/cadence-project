import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withDatabase } from "~/db";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { action as submit } from "./courses.$slug.refund";
import { loader as lessonDestination } from "./courses.$slug.lessons.$lessonId";
import { action as mutateInbox, loader as inbox } from "./api.notifications";
import { loader as buyerDestination } from "./settings";
import { action as decide, loader as reviewDestination } from "./admin.refunds";

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

async function decision(
  intent: "approve" | "decline",
  userId: number | null = admin.id,
  id = 1,
  note = "Decision note"
) {
  const req = await request(userId, "/admin/refunds", {
    intent,
    refundRequestId: String(id),
    note,
  });
  return withDatabase(db, () =>
    decide({ request: req, params: {}, context: {} } as Parameters<
      typeof decide
    >[0])
  );
}

it("gives the Individual Purchase buyer an approval confirmation after Enrollment ends", async () => {
  db.insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  await raise();
  await decision("approve");
  expect((await read(base.user.id)).items).toMatchObject([
    {
      title: "Refund Request approved",
      context: "Test Course · Purchase #1",
      destination: "/settings?refundRequestId=1#refund-request-1",
    },
    { title: "Refund Request received" },
  ]);
  expect(db.select().from(schema.enrollments).all()).toEqual([]);
  expect(await destination(base.user.id)).toMatchObject({
    selectedRefundRequestId: 1,
    refundRequests: [{ status: "approved", decisionNote: "Decision note" }],
  });
  expect((await read(admin.id)).items).toHaveLength(1);
  expect((await read(base.instructor.id)).items).toEqual([]);
  expect(mail.send).toHaveBeenCalledTimes(2);
  expect(mail.send.mock.calls.at(-1)).toEqual([
    {
      to: "test@example.com",
      subject: "Refund approved — Test Course",
      body: 'Hi Test User,\n\nWe have approved your refund request for "Test Course".\n$50.00, the full amount you paid, is on its way back to you.\n\nDecision note\n\n— The Cadence team',
    },
  ]);
});

it("gives the buyer a decline confirmation and preserves their Enrollment", async () => {
  db.insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
  await raise();
  await decision("decline");
  expect((await read(base.user.id)).items).toMatchObject([
    {
      title: "Refund Request declined",
      destination: "/settings?refundRequestId=1#refund-request-1",
    },
    { title: "Refund Request received" },
  ]);
  expect(db.select().from(schema.enrollments).all()).toHaveLength(1);
  expect(await destination(base.user.id)).toMatchObject({
    refundRequests: [{ status: "declined", decisionNote: "Decision note" }],
  });
  expect((await read(admin.id)).items).toHaveLength(1);
  expect(mail.send).toHaveBeenCalledTimes(2);
  expect(mail.send.mock.calls.at(-1)).toEqual([
    {
      to: "test@example.com",
      subject: "Refund declined — Test Course",
      body: 'Hi Test User,\n\nWe have looked at your refund request for "Test Course" and decided not to refund it.\n\nDecision note\n\nYou still have everything you bought. If something changes, you can raise a new refund request.\n\n— The Cadence team',
    },
  ]);
});

function teamLicence() {
  const team = db.insert(schema.teams).values({}).returning().get();
  db.insert(schema.coupons)
    .values(
      [1, 2].map((seat) => ({
        teamId: team.id,
        code: `SEAT-${seat}`,
        purchaseId: purchase.id,
        courseId: base.course.id,
      }))
    )
    .run();
}
async function notificationAction(
  userId: number | null,
  id: number,
  intent = "open"
) {
  const req = await request(userId, "/api/notifications", {
    id: String(id),
    intent,
  });
  return withDatabase(db, () =>
    mutateInbox({ request: req, params: {}, context: {} } as Parameters<
      typeof mutateInbox
    >[0])
  );
}

for (const intent of ["approve", "decline"] as const) {
  const status = intent === "approve" ? "approved" : "declined";
  it(`confirms a Team Licence ${status} decision without Enrollment or team membership`, async () => {
    teamLicence();
    await raise();
    await decision(intent);
    const entries = (await read(base.user.id)).items;
    expect(entries).toMatchObject([
      {
        title: `Refund Request ${status}`,
        context: "Test Course · Purchase #1",
        readAt: null,
      },
      { title: "Refund Request received", readAt: null },
    ]);
    expect(
      db
        .select()
        .from(schema.coupons)
        .all()
        .map((seat) => seat.refundedAt !== null)
    ).toEqual([intent === "approve", intent === "approve"]);
    expect(await notificationAction(base.user.id, entries[0].id)).toEqual({
      ok: true,
      destination: "/settings?refundRequestId=1#refund-request-1",
    });
    expect(await destination(base.user.id)).toMatchObject({
      selectedRefundRequestId: 1,
      refundRequests: [{ id: 1, status }],
    });
    expect(
      (await read(base.user.id)).items.map((entry) => entry.readAt === null)
    ).toEqual([false, true]);
    await notificationAction(base.user.id, entries[0].id, "unread");
    expect((await read(base.user.id)).unreadCount).toBe(2);
    expect(mail.send).toHaveBeenCalledTimes(2);
    expect((await read(admin.id)).items).toHaveLength(1);
    expect((await read(base.instructor.id)).items).toEqual([]);
    await expect(
      notificationAction(admin.id, entries[0].id)
    ).rejects.toMatchObject({ init: { status: 404 } });
    await expect(notificationAction(null, entries[0].id)).rejects.toMatchObject(
      { init: { status: 401 } }
    );
    await expect(destination(admin.id)).rejects.toMatchObject({
      init: { status: 404 },
    });
  });

  it(`keeps a self-deciding Platform Admin buyer's ${status} confirmation`, async () => {
    db.update(schema.users)
      .set({ role: schema.UserRole.Admin })
      .where(eq(schema.users.id, base.user.id))
      .run();
    await raise();
    await decision(intent, base.user.id);
    expect(
      (await read(base.user.id)).items.map((entry) => entry.title)
    ).toEqual([`Refund Request ${status}`, "Refund Request received"]);
    expect((await read(admin.id)).items).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(2);
    expect(await decision(intent, base.user.id)).toMatchObject({
      init: { status: 409 },
    });
    expect((await read(base.user.id)).items).toHaveLength(2);
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  for (const kind of ["Individual Purchase", "Team Licence"]) {
    it(`rolls back ${kind} ${status} effects on inbox failure and commits once on retry`, async () => {
      if (kind === "Team Licence") teamLicence();
      else
        db.insert(schema.enrollments)
          .values({ userId: base.user.id, courseId: base.course.id })
          .run();
      await raise();
      mail.send.mockClear();
      db.$client.exec(
        "CREATE TRIGGER fail_decision BEFORE INSERT ON notifications WHEN NEW.kind IN ('refund_approved', 'refund_declined') BEGIN SELECT RAISE(FAIL, 'Decision inbox failure'); END"
      );
      await expect(decision(intent)).rejects.toThrow("Decision inbox failure");
      expect(await destination(base.user.id)).toMatchObject({
        refundRequests: [{ status: "open", decisionNote: null }],
      });
      expect(db.select().from(schema.enrollments).all()).toHaveLength(
        kind === "Individual Purchase" ? 1 : 0
      );
      expect(
        db
          .select()
          .from(schema.coupons)
          .all()
          .every((seat) => seat.refundedAt === null)
      ).toBe(true);
      expect((await read(base.user.id)).items).toHaveLength(1);
      expect((await read(admin.id)).items).toHaveLength(1);
      expect(mail.send).not.toHaveBeenCalled();
      db.$client.exec("DROP TRIGGER fail_decision");
      await decision(intent);
      expect(await destination(base.user.id)).toMatchObject({
        refundRequests: [{ status, decisionNote: "Decision note" }],
      });
      expect(db.select().from(schema.enrollments).all()).toHaveLength(
        kind === "Individual Purchase" && intent === "decline" ? 1 : 0
      );
      expect(
        db
          .select()
          .from(schema.coupons)
          .all()
          .map((seat) => seat.refundedAt !== null)
      ).toEqual(
        kind === "Team Licence"
          ? [intent === "approve", intent === "approve"]
          : []
      );
      expect((await read(base.user.id)).items).toHaveLength(2);
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(await decision(intent)).toMatchObject({ init: { status: 409 } });
      expect((await read(base.user.id)).items).toHaveLength(2);
      expect(mail.send).toHaveBeenCalledTimes(1);
    });
  }

  it(`preserves the committed ${status} decision and entry when the existing email transport fails`, async () => {
    await raise();
    mail.send.mockClear();
    mail.send.mockRejectedValueOnce(new Error("Decision email unavailable"));
    await expect(decision(intent)).rejects.toThrow(
      "Decision email unavailable"
    );
    expect(await destination(base.user.id)).toMatchObject({
      refundRequests: [{ status }],
    });
    expect((await read(base.user.id)).items).toHaveLength(2);
    expect(await decision(intent)).toMatchObject({ init: { status: 409 } });
    expect(mail.send).toHaveBeenCalledTimes(1);
  });
}

it("rejects unauthenticated, non-Platform Admin, missing and invalid decisions without notifications or emails", async () => {
  await raise();
  mail.send.mockClear();
  await expect(decision("approve", null)).rejects.toMatchObject({
    init: { status: 401 },
  });
  await expect(decision("approve", base.user.id)).rejects.toMatchObject({
    init: { status: 403 },
  });
  expect(await decision("approve", admin.id, 999)).toMatchObject({
    init: { status: 404 },
  });
  expect(await decision("decline", admin.id, 1, "  ")).toMatchObject({
    init: { status: 400 },
  });
  expect(await destination(base.user.id)).toMatchObject({
    refundRequests: [{ status: "open" }],
  });
  expect((await read(base.user.id)).items).toHaveLength(1);
  expect(mail.send).not.toHaveBeenCalled();
});

it("rejects approval after a Seat is claimed without a decision entry, and still allows decline", async () => {
  teamLicence();
  await raise();
  db.update(schema.coupons)
    .set({
      redeemedAt: new Date().toISOString(),
      redeemedByUserId: base.instructor.id,
    })
    .where(eq(schema.coupons.id, 1))
    .run();
  mail.send.mockClear();
  expect(await decision("approve")).toMatchObject({ init: { status: 409 } });
  expect((await read(base.user.id)).items).toHaveLength(1);
  expect(
    db
      .select()
      .from(schema.coupons)
      .all()
      .every((seat) => seat.refundedAt === null)
  ).toBe(true);
  expect(mail.send).not.toHaveBeenCalled();
  await decision("decline");
  expect((await read(base.user.id)).items[0].title).toBe(
    "Refund Request declined"
  );
  expect(mail.send).toHaveBeenCalledTimes(1);
});

it("keeps confirmations for genuinely distinct requests on the same Purchase", async () => {
  await raise();
  await decision("decline");
  await raise();
  await decision("approve", admin.id, 2);
  expect((await read(base.user.id)).items).toMatchObject([
    {
      title: "Refund Request approved",
      destination: "/settings?refundRequestId=2#refund-request-2",
    },
    {
      title: "Refund Request received",
      destination: "/settings?refundRequestId=2#refund-request-2",
    },
    {
      title: "Refund Request declined",
      destination: "/settings?refundRequestId=1#refund-request-1",
    },
    {
      title: "Refund Request received",
      destination: "/settings?refundRequestId=1#refund-request-1",
    },
  ]);
  expect(mail.send).toHaveBeenCalledTimes(4);
  expect(await decision("decline", admin.id, 2)).toMatchObject({
    init: { status: 409 },
  });
  expect((await read(base.user.id)).items).toHaveLength(4);
  expect(mail.send).toHaveBeenCalledTimes(4);
});

for (const intent of ["approve", "decline"] as const) {
  it(`rechecks current Purchase ownership when presenting and opening a ${intent} confirmation`, async () => {
    await raise();
    await decision(intent);
    const entry = (await read(base.user.id)).items[0];
    db.update(schema.purchases)
      .set({ userId: admin.id })
      .where(eq(schema.purchases.id, purchase.id))
      .run();
    expect((await read(base.user.id)).items).toMatchObject([
      {
        title: "Notification unavailable",
        context: null,
        destination: null,
        readAt: null,
      },
      { title: "Notification unavailable", context: null, destination: null },
    ]);
    await expect(
      notificationAction(base.user.id, entry.id)
    ).rejects.toMatchObject({ init: { status: 404 } });
    await expect(destination(base.user.id)).rejects.toMatchObject({
      init: { status: 404 },
    });
    expect((await read(base.user.id)).unreadCount).toBe(2);
    expect((await read(admin.id)).items).toHaveLength(1);
  });
}

for (const claimedSeat of [false, true]) {
  it(`preserves progress and ${claimedSeat ? "retains Enrollment with a Claimed Seat" : "denies course content after Enrollment ends"} alongside the approval confirmation`, async () => {
    const module = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module", position: 1 })
      .returning()
      .get();
    const lesson = db
      .insert(schema.lessons)
      .values({ moduleId: module.id, title: "Lesson", position: 1 })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    db.insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: lesson.id,
        status: schema.LessonProgressStatus.InProgress,
      })
      .run();
    if (claimedSeat) {
      const team = db.insert(schema.teams).values({}).returning().get();
      const otherPurchase = db
        .insert(schema.purchases)
        .values({
          userId: admin.id,
          courseId: base.course.id,
          amountPaid: 5000,
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();
      db.insert(schema.coupons)
        .values({
          teamId: team.id,
          purchaseId: otherPurchase.id,
          courseId: base.course.id,
          code: "OTHER-PURCHASE-SEAT",
          redeemedByUserId: base.user.id,
          redeemedAt: new Date().toISOString(),
        })
        .run();
    }
    await raise();
    await decision("approve");
    const entry = (await read(base.user.id)).items[0];
    expect(await notificationAction(base.user.id, entry.id)).toMatchObject({
      destination: "/settings?refundRequestId=1#refund-request-1",
    });
    expect(await destination(base.user.id)).toMatchObject({
      refundRequests: [{ status: "approved" }],
    });
    const req = await request(base.user.id);
    const content = await withDatabase(db, () =>
      lessonDestination({
        request: req,
        params: { slug: base.course.slug, lessonId: String(lesson.id) },
        context: {},
      } as Parameters<typeof lessonDestination>[0])
    );
    expect(content.canViewContent).toBe(claimedSeat);
    expect(db.select().from(schema.lessonProgress).all()).toMatchObject([
      { status: schema.LessonProgressStatus.InProgress },
    ]);
    expect(db.select().from(schema.enrollments).all()).toHaveLength(
      claimedSeat ? 1 : 0
    );
  });
}
