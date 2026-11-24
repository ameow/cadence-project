import { z } from "zod";

export const saveNoteSchema = z.object({
  body: z.string().trim().max(2000, "Notes must be 2,000 characters or fewer."),
});
