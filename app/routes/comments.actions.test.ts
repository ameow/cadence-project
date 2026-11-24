import { afterEach, beforeEach, expect, it } from "vitest";
import { withDatabase } from "~/db";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import { action as postLesson } from "./courses.$slug.lessons.$lessonId";
import { action as postInstructor } from "./instructor.questions";
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
