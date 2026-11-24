import { afterEach, beforeEach, expect, it } from "vitest";
import { withDatabase } from "~/db";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { loader as lessonDestination } from "./courses.$slug.lessons.$lessonId";
import { action as postLesson } from "./courses.$slug.lessons.$lessonId";
import { action as postInstructor } from "./instructor.questions";
import { eq } from "drizzle-orm";
import { action as updateNotification } from "./api.notifications";
import { loader as inbox } from "./api.notifications";
import { insertNotifications } from "~/lib/notifications.server";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lesson: typeof schema.lessons.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  lesson = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "First lesson", position: 1 })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId: base.user.id, courseId: base.course.id })
    .run();
});

afterEach(() => db.$client.close());

async function post(
  route: "lesson" | "instructor",
  userId: number | null,
  fields: Record<string, string>,
  lessonId = lesson.id
) {
  const headers = new Headers();
  if (userId !== null)
    headers.set(
      "Cookie",
      await setCurrentUserId(new Request("http://localhost"), userId)
    );
  const request = new Request("http://localhost", {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
  return withDatabase(db, () =>
    route === "lesson"
      ? postLesson({
          request,
          params: { slug: base.course.slug, lessonId: String(lessonId) },
          context: {},
        } as Parameters<typeof postLesson>[0])
      : postInstructor({ request, params: {}, context: {} } as Parameters<
          typeof postInstructor
        >[0])
  );
}

it("lets an enrolled Student post a trimmed lesson question", async () => {
  expect(
    await post("lesson", base.user.id, {
      intent: "create-comment",
      body: "  How does this work?  ",
    })
  ).toEqual({ ok: true });
  expect(db.select().from(schema.comments).all()).toMatchObject([
    {
      userId: base.user.id,
      lessonId: lesson.id,
      parentId: null,
      body: "How does this work?",
    },
  ]);
});

it.each(["lesson", "instructor"] as const)(
  "rolls back a failed %s post and permits a clean retry",
  async (route) => {
    const question = db
      .insert(schema.comments)
      .values({ userId: base.user.id, lessonId: lesson.id, body: "A question" })
      .returning()
      .get();
    const fields: Record<string, string> =
      route === "lesson"
        ? {
            intent: "create-comment",
            parentId: String(question.id),
            body: "  An answer  ",
          }
        : {
            intent: "reply",
            commentId: String(question.id),
            body: "  An answer  ",
          };
    db.$client.exec(
      "CREATE TRIGGER fail_comment AFTER INSERT ON comments BEGIN SELECT RAISE(FAIL, 'Controlled write failure'); END"
    );
    expect(await post(route, base.instructor.id, fields)).toEqual({
      ok: false,
      error: "Controlled write failure",
    });
    expect(db.select().from(schema.comments).all()).toHaveLength(1);
    db.$client.exec("DROP TRIGGER fail_comment");
    expect(await post(route, base.instructor.id, fields)).toEqual({ ok: true });
    expect(db.select().from(schema.comments).all()).toMatchObject([
      { id: question.id },
      {
        userId: base.instructor.id,
        parentId: question.id,
        lessonId: lesson.id,
        body: "An answer",
      },
    ]);
  }
);

function question(lessonId = lesson.id, parentId: number | null = null) {
  return db
    .insert(schema.comments)
    .values({ userId: base.user.id, lessonId, parentId, body: "A question" })
    .returning()
    .get();
}

function replyFields(
  route: "lesson" | "instructor",
  commentId: number,
  body = "An answer"
): Record<string, string> {
  return route === "lesson"
    ? { intent: "create-comment", parentId: String(commentId), body }
    : { intent: "reply", commentId: String(commentId), body };
}

it.each(["lesson", "instructor"] as const)(
  "preserves %s reply body validation",
  async (route) => {
    const parent = question();
    for (const [body, error] of [
      [" \n ", "Comment cannot be empty"],
      [
        "x".repeat(MAX_COMMENT_LENGTH + 1),
        `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
      ],
    ]) {
      expect(
        await post(
          route,
          base.instructor.id,
          replyFields(route, parent.id, body)
        )
      ).toEqual({ ok: false, error });
    }
    expect(db.select().from(schema.comments).all()).toHaveLength(1);
    expect(
      await post(
        route,
        base.instructor.id,
        replyFields(route, parent.id, "x".repeat(MAX_COMMENT_LENGTH))
      )
    ).toEqual({ ok: true });
  }
);

it.each(["lesson", "instructor"] as const)(
  "rejects nested %s replies",
  async (route) => {
    const parent = question();
    const reply = question(lesson.id, parent.id);
    expect(
      await post(route, base.instructor.id, replyFields(route, reply.id))
    ).toEqual({ ok: false, error: "Replies can only be one level deep" });
    expect(db.select().from(schema.comments).all()).toHaveLength(2);
  }
);

it("rejects a lesson reply whose parent belongs to another lesson", async () => {
  const otherLesson = db
    .insert(schema.lessons)
    .values({ moduleId: lesson.moduleId, title: "Other", position: 2 })
    .returning()
    .get();
  const parent = question(otherLesson.id);
  expect(
    await post("lesson", base.user.id, replyFields("lesson", parent.id))
  ).toEqual({
    ok: false,
    error: "Parent comment belongs to a different lesson",
  });
  expect(db.select().from(schema.comments).all()).toHaveLength(1);
});

it("preserves missing lesson and parent errors", async () => {
  expect(
    await post(
      "lesson",
      base.user.id,
      { intent: "create-comment", body: "A question" },
      999
    )
  ).toEqual({ ok: false, error: "Lesson not found" });
  expect(
    await post("lesson", base.user.id, replyFields("lesson", 999))
  ).toEqual({ ok: false, error: "Parent comment not found" });
  await expect(
    post("instructor", base.instructor.id, replyFields("instructor", 999))
  ).rejects.toMatchObject({
    init: { status: 404 },
    data: "Question not found",
  });
  expect(db.select().from(schema.comments).all()).toEqual([]);
});

it.each(["lesson", "instructor"] as const)(
  "requires authentication directly in the %s action",
  async (route) => {
    const parent = question();
    await expect(
      post(route, null, replyFields(route, parent.id))
    ).rejects.toMatchObject({ init: { status: 401 } });
    expect(db.select().from(schema.comments).all()).toHaveLength(1);
  }
);

it("rejects a Student without Enrollment and an Instructor who does not own the course", async () => {
  const outsider = db
    .insert(schema.users)
    .values({
      name: "Other Instructor",
      email: "other@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
  const parent = question();
  await expect(
    post("lesson", outsider.id, replyFields("lesson", parent.id))
  ).rejects.toMatchObject({ init: { status: 403 } });
  await expect(
    post("instructor", outsider.id, replyFields("instructor", parent.id))
  ).rejects.toMatchObject({ init: { status: 403 } });
  await expect(
    post("instructor", base.user.id, replyFields("instructor", parent.id))
  ).rejects.toMatchObject({ init: { status: 403 } });
  expect(db.select().from(schema.comments).all()).toHaveLength(1);
});

it.each(["lesson", "instructor"] as const)(
  "lets a Platform Admin reply through the %s action without Enrollment",
  async (route) => {
    const admin = db
      .insert(schema.users)
      .values({
        name: "Platform Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const parent = question();
    expect(await post(route, admin.id, replyFields(route, parent.id))).toEqual({
      ok: true,
    });
    expect(db.select().from(schema.comments).all()).toMatchObject([
      { id: parent.id },
      { userId: admin.id, parentId: parent.id },
    ]);
  }
);

it("delivers a Student question to the owning Instructor inbox", async () => {
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "A question",
  });
  const cookie = await setCurrentUserId(
    new Request("http://localhost"),
    base.instructor.id
  );
  const result = await withDatabase(db, () =>
    inbox({
      request: new Request("http://localhost/api/notifications", {
        headers: { Cookie: cookie },
      }),
      params: {},
      context: {},
    } as Parameters<typeof inbox>[0])
  );
  expect(result.unreadCount).toBe(1);
  expect(result.items).toMatchObject([
    {
      title: "Test User asked a question",
      context: "Test Course · First lesson",
      readAt: null,
    },
  ]);
});

async function readInbox(userId: number | null, search = "") {
  const headers = new Headers();
  if (userId !== null)
    headers.set(
      "Cookie",
      await setCurrentUserId(new Request("http://localhost"), userId)
    );
  return withDatabase(db, () =>
    inbox({
      request: new Request(`http://localhost/api/notifications${search}`, {
        headers,
      }),
      params: {},
      context: {},
    } as Parameters<typeof inbox>[0])
  );
}

async function notificationAction(
  userId: number | null,
  fields: Record<string, string>
) {
  const headers = new Headers();
  if (userId !== null)
    headers.set(
      "Cookie",
      await setCurrentUserId(new Request("http://localhost"), userId)
    );
  return withDatabase(db, () =>
    updateNotification({
      request: new Request("http://localhost/api/notifications", {
        method: "POST",
        headers,
        body: new URLSearchParams(fields),
      }),
      params: {},
      context: {},
    } as Parameters<typeof updateNotification>[0])
  );
}

it("rolls back a question when its inbox write fails and permits retry", async () => {
  db.$client.exec(
    "CREATE TRIGGER fail_inbox AFTER INSERT ON notifications BEGIN SELECT RAISE(FAIL, 'Inbox failure'); END"
  );
  expect(
    await post("lesson", base.user.id, {
      intent: "create-comment",
      body: "Question",
    })
  ).toEqual({ ok: false, error: "Inbox failure" });
  expect(db.select().from(schema.comments).all()).toEqual([]);
  expect((await readInbox(base.instructor.id)).items).toEqual([]);
  db.$client.exec("DROP TRIGGER fail_inbox");
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "Question",
  });
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(1);
});

it("preserves independent read state, filters locally, and opens only the chosen question", async () => {
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "First question",
  });
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "Second question",
  });
  const initial = await readInbox(base.instructor.id);
  const first = initial.items[0];
  if (!first) throw new Error("Missing notification");
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(2);
  expect(
    await notificationAction(base.instructor.id, {
      intent: "open",
      id: String(first.id),
    })
  ).toEqual({ ok: true, destination: first.destination });
  expect(first.destination).toMatch(
    /^\/courses\/test-course\/lessons\/\d+#comment-\d+$/
  );
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(1);
  await notificationAction(base.instructor.id, {
    intent: "unread",
    id: String(first.id),
  });
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(2);
  await notificationAction(base.instructor.id, {
    intent: "read",
    id: String(first.id),
  });
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(1);
  await notificationAction(base.instructor.id, {
    intent: "mark-all",
    recipientId: String(base.user.id),
  });
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(0);
});

it("authenticates every endpoint and rejects cross-recipient mutations even for a Platform Admin", async () => {
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "Question",
  });
  const entry = (await readInbox(base.instructor.id)).items[0];
  if (!entry) throw new Error("Missing notification");
  const admin = db
    .insert(schema.users)
    .values({
      name: "Platform Admin",
      email: "admin@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
  await expect(readInbox(null)).rejects.toMatchObject({
    init: { status: 401 },
  });
  for (const intent of ["read", "unread", "open", "mark-all"]) {
    await expect(
      notificationAction(null, { intent, id: String(entry.id) })
    ).rejects.toMatchObject({ init: { status: 401 } });
  }
  for (const userId of [base.user.id, admin.id]) {
    expect(
      (await readInbox(userId, `?recipientId=${base.instructor.id}`)).items
    ).toEqual([]);
    for (const intent of ["read", "unread", "open"]) {
      await expect(
        notificationAction(userId, {
          intent,
          id: String(entry.id),
          recipientId: String(base.instructor.id),
        })
      ).rejects.toMatchObject({ init: { status: 404 } });
    }
    await notificationAction(userId, {
      intent: "mark-all",
      recipientId: String(base.instructor.id),
    });
  }
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(1);
  await expect(
    notificationAction(base.instructor.id, { intent: "read", id: "garbage" })
  ).rejects.toMatchObject({ init: { status: 400 } });
});

it("keeps event-time recipients while current ownership controls historical presentation and opening", async () => {
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "Old question",
  });
  const next = db
    .insert(schema.users)
    .values({
      name: "New Instructor",
      email: "new@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
  db.update(schema.courses)
    .set({ instructorId: next.id })
    .where(eq(schema.courses.id, base.course.id))
    .run();
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "New question",
  });
  const old = await readInbox(base.instructor.id);
  expect(old.items).toMatchObject([
    { title: "Notification unavailable", context: null, destination: null },
  ]);
  expect(old.unreadCount).toBe(1);
  expect((await readInbox(next.id)).items).toHaveLength(1);
  const entry = old.items[0];
  if (!entry) throw new Error("Missing notification");
  await expect(
    notificationAction(base.instructor.id, {
      intent: "open",
      id: String(entry.id),
    })
  ).rejects.toMatchObject({ init: { status: 404 } });
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(1);
});

it("shows deleted questions generically and emits no entries for staff, edits or deletions", async () => {
  await post("lesson", base.instructor.id, {
    intent: "create-comment",
    body: "Staff question",
  });
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "Student question",
  });
  const entry = (await readInbox(base.instructor.id)).items[0];
  const question = db
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.userId, base.user.id))
    .get();
  if (!entry || !question) throw new Error("Missing question");
  await post("lesson", base.user.id, {
    intent: "edit-comment",
    commentId: String(question.id),
    body: "Edited question",
  });
  await post("lesson", base.user.id, {
    intent: "delete-comment",
    commentId: String(question.id),
  });
  expect((await readInbox(base.instructor.id)).items).toMatchObject([
    {
      id: entry.id,
      title: "Notification unavailable",
      context: null,
      destination: null,
    },
  ]);
  await expect(
    notificationAction(base.instructor.id, {
      intent: "open",
      id: String(entry.id),
    })
  ).rejects.toMatchObject({ init: { status: 404 } });
});

it("enforces event/recipient uniqueness without merging distinct questions", async () => {
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "Question",
  });
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "Question",
  });
  const entry = db.select().from(schema.notifications).get();
  if (!entry) throw new Error("Missing event");
  await notificationAction(base.instructor.id, {
    intent: "read",
    id: String(entry.id),
  });
  await expect(
    Promise.resolve().then(() =>
      db
        .insert(schema.notifications)
        .values({
          recipientId: entry.recipientId,
          eventKey: entry.eventKey,
          kind: entry.kind,
          commentId: entry.commentId,
        })
        .run()
    )
  ).rejects.toThrow(/UNIQUE/);
  expect((await readInbox(base.instructor.id)).items).toHaveLength(2);
  expect((await readInbox(base.instructor.id)).unreadCount).toBe(1);
});

it("opens the actual question through the lesson loader without granting course access", async () => {
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "A destination question",
  });
  async function destination(userId: number) {
    const cookie = await setCurrentUserId(
      new Request("http://localhost"),
      userId
    );
    return withDatabase(db, () =>
      lessonDestination({
        request: new Request(
          `http://localhost/courses/${base.course.slug}/lessons/${lesson.id}`,
          { headers: { Cookie: cookie } }
        ),
        params: { slug: base.course.slug, lessonId: String(lesson.id) },
        context: {},
      } as Parameters<typeof lessonDestination>[0])
    );
  }
  const authorized = await destination(base.instructor.id);
  expect(authorized.comments).toMatchObject([
    { body: "A destination question" },
  ]);
  const entry = (await readInbox(base.instructor.id)).items[0];
  expect(entry?.destination).toBe(
    `/courses/test-course/lessons/${lesson.id}#comment-${authorized.comments[0]?.id}`
  );
  const outsider = db
    .insert(schema.users)
    .values({
      name: "Other Student",
      email: "outside@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
  const denied = await destination(outsider.id);
  expect(denied.canViewContent).toBe(false);
  expect(denied.comments).toEqual([]);
});

it("suppresses the actor's own lesson alert even if a Student owns the course", async () => {
  db.update(schema.courses)
    .set({ instructorId: base.user.id })
    .where(eq(schema.courses.id, base.course.id))
    .run();
  await post("lesson", base.user.id, {
    intent: "create-comment",
    body: "Own question",
  });
  expect((await readInbox(base.user.id)).items).toEqual([]);
});

it("treats an enrolled non-owning Instructor as a Student in this course", async () => {
  const instructor = db
    .insert(schema.users)
    .values({
      name: "Visiting Instructor",
      email: "visiting@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId: instructor.id, courseId: base.course.id })
    .run();
  await post("lesson", instructor.id, {
    intent: "create-comment",
    body: "Taking this course",
  });
  expect((await readInbox(base.instructor.id)).items).toMatchObject([
    { title: "Visiting Instructor asked a question" },
  ]);
});

it.each(["lesson", "instructor"] as const)(
  "delivers an owning Instructor's %s reply to the Student asker",
  async (route) => {
    await post("lesson", base.user.id, {
      intent: "create-comment",
      body: "Question",
    });
    const parent = db.select().from(schema.comments).get();
    if (!parent) throw new Error("Missing question");
    expect(
      await post(route, base.instructor.id, replyFields(route, parent.id))
    ).toEqual({ ok: true });
    const result = await readInbox(base.user.id);
    expect(result.items).toMatchObject([
      {
        title: "Test Instructor replied to a question",
        context: "Test Course · First lesson",
        readAt: null,
      },
    ]);
    expect(result.items[0]?.destination).toMatch(/#comment-2$/);
    expect((await readInbox(base.instructor.id)).items).toHaveLength(1);
  }
);

function participant(role = schema.UserRole.Student) {
  const person = db
    .insert(schema.users)
    .values({
      name: "Participant",
      email: `participant-${role}@example.com`,
      role,
    })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId: person.id, courseId: base.course.id })
    .run();
  return person;
}

async function postedQuestion(userId = base.user.id) {
  await post("lesson", userId, { intent: "create-comment", body: "Question" });
  const parent = db.select().from(schema.comments).get();
  if (!parent) throw new Error("Missing question");
  return parent;
}

it.each([schema.UserRole.Student, schema.UserRole.Instructor])(
  "alerts only the asker and owning Instructor for an enrolled %s reply",
  async (role) => {
    const parent = await postedQuestion();
    const actor = participant(role);
    await post("lesson", actor.id, replyFields("lesson", parent.id));
    expect((await readInbox(base.user.id)).items).toMatchObject([
      { title: "Participant replied to a question" },
    ]);
    expect((await readInbox(base.instructor.id)).items).toHaveLength(2);
    expect((await readInbox(actor.id)).items).toEqual([]);
  }
);

it("alerts only the owning Instructor when the asker replies and keeps distinct reply events", async () => {
  const parent = await postedQuestion();
  await post("lesson", base.user.id, replyFields("lesson", parent.id));
  await post("lesson", base.user.id, replyFields("lesson", parent.id));
  expect((await readInbox(base.instructor.id)).items).toHaveLength(3);
  expect((await readInbox(base.user.id)).items).toEqual([]);
});

it.each(["lesson", "instructor"] as const)(
  "alerts only the asker when a Platform Admin replies through %s",
  async (route) => {
    const parent = await postedQuestion();
    const admin = participant(schema.UserRole.Admin);
    const other = db
      .insert(schema.users)
      .values({
        name: "Other Admin",
        email: "other-admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    await post(route, admin.id, replyFields(route, parent.id));
    expect((await readInbox(base.user.id)).items).toMatchObject([
      { title: "Participant replied to a question" },
    ]);
    expect((await readInbox(base.instructor.id)).items).toHaveLength(1);
    expect((await readInbox(admin.id)).items).toEqual([]);
    expect((await readInbox(other.id)).items).toEqual([]);
  }
);

it.each([schema.UserRole.Admin, schema.UserRole.Instructor])(
  "never alerts for a %s-started staff thread, even after its author becomes a Student",
  async (role) => {
    const author =
      role === schema.UserRole.Instructor ? base.instructor : participant(role);
    const parent = await postedQuestion(author.id);
    db.update(schema.users)
      .set({ role: schema.UserRole.Student })
      .where(eq(schema.users.id, author.id))
      .run();
    if (author.id === base.instructor.id) {
      db.update(schema.courses)
        .set({ instructorId: base.user.id })
        .where(eq(schema.courses.id, base.course.id))
        .run();
    }
    await post("lesson", base.user.id, replyFields("lesson", parent.id));
    expect(db.select().from(schema.notifications).all()).toEqual([]);
  }
);

it("retains Student thread origin after the asker becomes a Platform Admin", async () => {
  const parent = await postedQuestion();
  db.update(schema.users)
    .set({ role: schema.UserRole.Admin })
    .where(eq(schema.users.id, base.user.id))
    .run();
  await post(
    "instructor",
    base.instructor.id,
    replyFields("instructor", parent.id)
  );
  expect((await readInbox(base.user.id)).items).toMatchObject([
    { title: "Test Instructor replied to a question" },
  ]);
});

it("retains Student thread origin and resolves current ownership for later replies", async () => {
  const parent = await postedQuestion();
  const actor = participant();
  await post("lesson", actor.id, replyFields("lesson", parent.id));
  db.update(schema.courses)
    .set({ instructorId: base.user.id })
    .where(eq(schema.courses.id, base.course.id))
    .run();
  await post("lesson", actor.id, replyFields("lesson", parent.id));
  expect((await readInbox(base.user.id)).items).toHaveLength(2);
  expect((await readInbox(base.instructor.id)).items).toHaveLength(2);
  expect(
    (await readInbox(base.instructor.id)).items.every(
      (item) => item.destination === null
    )
  ).toBe(true);
});

it("rolls back the reply and partial recipient set on inbox failure, then retries cleanly", async () => {
  const parent = await postedQuestion();
  const actor = participant();
  db.$client
    .exec(`CREATE TRIGGER fail_second_recipient AFTER INSERT ON notifications
    WHEN NEW.kind = 'lesson-reply' AND NEW.recipient_id = ${base.instructor.id}
    BEGIN SELECT RAISE(FAIL, 'Second recipient failed'); END`);
  expect(
    await post("lesson", actor.id, replyFields("lesson", parent.id))
  ).toEqual({ ok: false, error: "Second recipient failed" });
  expect(db.select().from(schema.comments).all()).toHaveLength(1);
  expect((await readInbox(base.user.id)).items).toEqual([]);
  expect((await readInbox(base.instructor.id)).items).toHaveLength(1);
  db.$client.exec("DROP TRIGGER fail_second_recipient");
  expect(
    await post("lesson", actor.id, replyFields("lesson", parent.id))
  ).toEqual({ ok: true });
  expect(db.select().from(schema.comments).all()).toHaveLength(2);
  expect((await readInbox(base.user.id)).items).toHaveLength(1);
  expect((await readInbox(base.instructor.id)).items).toHaveLength(2);
});

it.each(["lesson", "instructor"] as const)(
  "rolls back an Instructor's %s reply if its asker inbox write fails",
  async (route) => {
    const parent = await postedQuestion();
    db.$client.exec(
      "CREATE TRIGGER fail_reply_inbox AFTER INSERT ON notifications WHEN NEW.kind = 'lesson-reply' BEGIN SELECT RAISE(FAIL, 'Reply inbox failure'); END"
    );
    expect(
      await post(route, base.instructor.id, replyFields(route, parent.id))
    ).toEqual({ ok: false, error: "Reply inbox failure" });
    expect(db.select().from(schema.comments).all()).toHaveLength(1);
    expect((await readInbox(base.user.id)).items).toEqual([]);
    db.$client.exec("DROP TRIGGER fail_reply_inbox");
    expect(
      await post(route, base.instructor.id, replyFields(route, parent.id))
    ).toEqual({ ok: true });
    expect((await readInbox(base.user.id)).items).toHaveLength(1);
  }
);

it("does not alert other participating Students and preserves read controls on reply destinations", async () => {
  const parent = await postedQuestion();
  const other = participant();
  await post("lesson", other.id, replyFields("lesson", parent.id));
  await post(
    "instructor",
    base.instructor.id,
    replyFields("instructor", parent.id)
  );
  expect((await readInbox(other.id)).items).toEqual([]);
  const entries = await readInbox(base.user.id);
  const replyEntry = entries.items[0];
  if (!replyEntry) throw new Error("Missing reply entry");
  expect(
    await notificationAction(base.user.id, {
      intent: "open",
      id: String(replyEntry.id),
    })
  ).toEqual({ ok: true, destination: replyEntry.destination });
  expect((await readInbox(base.user.id)).unreadCount).toBe(1);
  const cookie = await setCurrentUserId(
    new Request("http://localhost"),
    base.user.id
  );
  const destination = await withDatabase(db, () =>
    lessonDestination({
      request: new Request(`http://localhost${replyEntry.destination}`, {
        headers: { Cookie: cookie },
      }),
      params: { slug: base.course.slug, lessonId: String(lesson.id) },
      context: {},
    } as Parameters<typeof lessonDestination>[0])
  );
  expect(destination.comments[0]?.replies).toMatchObject([
    { author: { id: other.id } },
    { author: { id: base.instructor.id } },
  ]);
  db.delete(schema.enrollments)
    .where(eq(schema.enrollments.userId, base.user.id))
    .run();
  const unavailable = await readInbox(base.user.id);
  expect(
    unavailable.items.every(
      (item) =>
        item.title === "Notification unavailable" &&
        item.destination === null &&
        item.context === null
    )
  ).toBe(true);
  await expect(
    notificationAction(base.user.id, {
      intent: "open",
      id: String(replyEntry.id),
    })
  ).rejects.toMatchObject({ init: { status: 404 } });
});

it("re-emits a reply event without duplicating recipients or resetting read state", async () => {
  const parent = await postedQuestion();
  await post(
    "instructor",
    base.instructor.id,
    replyFields("instructor", parent.id)
  );
  const item = (await readInbox(base.user.id)).items[0];
  if (!item) throw new Error("Missing reply entry");
  await notificationAction(base.user.id, {
    intent: "read",
    id: String(item.id),
  });
  const event = db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.id, item.id))
    .get();
  if (!event) throw new Error("Missing event");
  withDatabase(db, () =>
    db.transaction((tx) =>
      insertNotifications(tx, [
        {
          recipientId: event.recipientId,
          actorId: event.actorId,
          kind: event.kind,
          eventKey: event.eventKey,
          commentId: event.commentId,
        },
      ])
    )
  );
  expect((await readInbox(base.user.id)).items).toHaveLength(1);
  expect((await readInbox(base.user.id)).unreadCount).toBe(0);
});

it("makes a deleted reply unavailable and adds no entries when a reply is edited or deleted", async () => {
  const parent = await postedQuestion();
  await post(
    "instructor",
    base.instructor.id,
    replyFields("instructor", parent.id)
  );
  const entry = (await readInbox(base.user.id)).items[0];
  const reply = db
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.parentId, parent.id))
    .get();
  if (!entry || !reply) throw new Error("Missing reply");
  await post("lesson", base.instructor.id, {
    intent: "edit-comment",
    commentId: String(reply.id),
    body: "Edited reply",
  });
  expect((await readInbox(base.user.id)).items).toHaveLength(1);
  await post("lesson", base.instructor.id, {
    intent: "delete-comment",
    commentId: String(reply.id),
  });
  expect((await readInbox(base.user.id)).items).toMatchObject([
    {
      id: entry.id,
      title: "Notification unavailable",
      context: null,
      destination: null,
    },
  ]);
  await expect(
    notificationAction(base.user.id, { intent: "open", id: String(entry.id) })
  ).rejects.toMatchObject({ init: { status: 404 } });
});
