import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  getBookmark,
  getNote,
  getSavedItems,
  saveNote,
  toggleBookmark,
} from "./saved.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let otherLessonId: number;
const NOW = new Date("2026-11-24T12:00:00Z");
const LATER = new Date("2026-11-24T13:00:00Z");

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  const lesson = (position: number) =>
    db
      .insert(schema.lessons)
      .values({ moduleId: module.id, title: `Lesson ${position}`, position })
      .returning()
      .get().id;
  lessonId = lesson(1);
  otherLessonId = lesson(2);
});

describe("Bookmarks and Notes", () => {
  it("toggles a Bookmark on and off without duplicate Saved rows", () => {
    expect(toggleBookmark(db, base.user.id, lessonId)).toBe(true);
    expect(getBookmark(db, base.user.id, lessonId)).toBeDefined();
    expect(getSavedItems(db, base.user.id).savedBookmarks).toHaveLength(1);
    expect(toggleBookmark(db, base.user.id, lessonId)).toBe(false);
    expect(getBookmark(db, base.user.id, lessonId)).toBeUndefined();
    expect(getSavedItems(db, base.user.id).savedBookmarks).toEqual([]);
  });

  it("creates and replaces one trimmed plain-text Note and advances last edited", () => {
    expect(getNote(db, base.user.id, lessonId)).toBeUndefined();
    saveNote(db, base.user.id, lessonId, "  # Heading\n*literal text*  ", NOW);
    expect(getNote(db, base.user.id, lessonId)).toEqual({
      body: "# Heading\n*literal text*",
      updatedAt: NOW.toISOString(),
    });
    saveNote(db, base.user.id, lessonId, "Revised", LATER);
    expect(getNote(db, base.user.id, lessonId)).toEqual({
      body: "Revised",
      updatedAt: LATER.toISOString(),
    });
    expect(getSavedItems(db, base.user.id).savedNotes).toHaveLength(1);
    saveNote(db, base.user.id, lessonId, "   ", LATER);
    expect(getNote(db, base.user.id, lessonId)?.body).toBe("");
  });

  it("accepts exactly 2,000 characters and refuses longer Notes without changing saved text", () => {
    saveNote(db, base.user.id, lessonId, "x".repeat(2000), NOW);
    expect(() =>
      saveNote(db, base.user.id, lessonId, "x".repeat(2001), LATER)
    ).toThrow("2,000 characters or fewer");
    expect(getNote(db, base.user.id, lessonId)).toEqual({
      body: "x".repeat(2000),
      updatedAt: NOW.toISOString(),
    });
  });

  it("lists only the owner's rows, newest activity first, with Lesson and Course details", () => {
    const other = db
      .insert(schema.users)
      .values({
        name: "Other",
        email: "other@example.com",
        role: schema.UserRole.Student,
      })
      .returning()
      .get();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      toggleBookmark(db, base.user.id, lessonId);
      saveNote(db, base.user.id, lessonId, "First", NOW);
      vi.setSystemTime(LATER);
      toggleBookmark(db, base.user.id, otherLessonId);
      saveNote(db, base.user.id, otherLessonId, "Second", LATER);
      toggleBookmark(db, other.id, lessonId);
      saveNote(db, other.id, lessonId, "Private", LATER);
      const saved = getSavedItems(db, base.user.id);
      for (const rows of [saved.savedBookmarks, saved.savedNotes]) {
        expect(rows.map((row) => row.lessonId)).toEqual([
          otherLessonId,
          lessonId,
        ]);
        expect(rows[0]).toMatchObject({
          lessonTitle: "Lesson 2",
          courseTitle: base.course.title,
          courseSlug: base.course.slug,
        });
      }
      saveNote(
        db,
        base.user.id,
        lessonId,
        "Latest revision",
        new Date(LATER.getTime() + 1000)
      );
      expect(
        getSavedItems(db, base.user.id).savedNotes.map((row) => row.body)
      ).toEqual(["Latest revision", "Second"]);
      expect(getNote(db, other.id, lessonId)?.body).toBe("Private");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Bookmarks and Notes when a Refund is approved", async () => {
    const notifications = fakeNotifications();
    const admin = db
      .insert(schema.users)
      .values({
        name: "Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    toggleBookmark(db, base.user.id, lessonId);
    saveNote(db, base.user.id, lessonId, "Keep this", NOW);
    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Changed my mind",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error("Refund request failed");
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      NOW,
      notifications
    );
    expect(approved.ok).toBe(true);
    expect(getBookmark(db, base.user.id, lessonId)).toBeDefined();
    expect(getNote(db, base.user.id, lessonId)?.body).toBe("Keep this");
  });
});
