import { eq } from "drizzle-orm";
import { db } from "~/db";
import {
  comments,
  courses,
  lessons,
  modules,
  users,
  UserRole,
} from "~/db/schema";
import { insertNotifications } from "~/lib/notifications.server";
import { MIN_COMMENT_LENGTH, MAX_COMMENT_LENGTH } from "~/lib/comments";

/** The comment and complete recipient set share this transaction boundary. */
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
      .select({ id: courses.id, instructorId: courses.instructorId })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .where(eq(lessons.id, lessonId))
      .get();
    if (!course) throw new Error("Lesson not found");

    let parent: typeof comments.$inferSelect | undefined;
    if (parentId !== null) {
      parent = tx
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

    const actor = tx.select().from(users).where(eq(users.id, userId)).get();
    const isStudent =
      actor?.role !== UserRole.Admin && course.instructorId !== userId;
    const comment = tx
      .insert(comments)
      .values({
        userId,
        lessonId,
        parentId,
        body: trimmed,
        studentStarted: parentId === null && isStudent,
      })
      .returning()
      .get();
    if (parentId === null && isStudent) {
      insertNotifications(tx, [
        {
          recipientId: course.instructorId,
          actorId: userId,
          kind: "lesson-question",
          eventKey: `comment:${comment.id}`,
          commentId: comment.id,
        },
      ]);
    }
    if (parent?.studentStarted) {
      const recipients = isStudent
        ? [parent.userId, course.instructorId]
        : [parent.userId];
      insertNotifications(
        tx,
        [...new Set(recipients)]
          .filter((recipientId) => recipientId !== userId)
          .map((recipientId) => ({
            recipientId,
            actorId: userId,
            kind: "lesson-reply",
            eventKey: `comment:${comment.id}`,
            commentId: comment.id,
          }))
      );
    }
    return comment;
  });
}
