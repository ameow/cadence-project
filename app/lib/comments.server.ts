import { eq } from "drizzle-orm";
import { db } from "~/db";
import { comments, courses, lessons, modules } from "~/db/schema";
import { MIN_COMMENT_LENGTH, MAX_COMMENT_LENGTH } from "~/lib/comments";

/** The comment and any future inbox entries share this transaction boundary. */
export function createComment(
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string
) {
  return db.transaction((tx) => {
    const trimmed = body.trim();
    if (trimmed.length < MIN_COMMENT_LENGTH) {
      throw new Error("Comment cannot be empty");
    }
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new Error(
        `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`
      );
    }

    const course = tx
      .select({ id: courses.id })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .where(eq(lessons.id, lessonId))
      .get();
    if (!course) throw new Error("Lesson not found");

    if (parentId !== null) {
      const parent = tx
        .select()
        .from(comments)
        .where(eq(comments.id, parentId))
        .get();
      if (!parent) throw new Error("Parent comment not found");
      if (parent.lessonId !== lessonId) {
        throw new Error("Parent comment belongs to a different lesson");
      }
      if (parent.parentId !== null) {
        throw new Error("Replies can only be one level deep");
      }
    }

    return tx
      .insert(comments)
      .values({ userId, lessonId, parentId, body: trimmed })
      .returning()
      .get();
  });
}
