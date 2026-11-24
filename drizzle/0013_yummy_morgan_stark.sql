ALTER TABLE `comments` ADD `student_started` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Legacy threads have no origin history. Classify once from existing course membership;
-- future events retain this value even when roles or ownership change.
UPDATE comments SET student_started = 1
WHERE parent_id IS NULL AND EXISTS (
  SELECT 1 FROM lessons
  JOIN modules ON modules.id = lessons.module_id
  JOIN courses ON courses.id = modules.course_id
  JOIN users ON users.id = comments.user_id
  WHERE lessons.id = comments.lesson_id
    AND users.role != 'admin'
    AND courses.instructor_id != comments.user_id
);
