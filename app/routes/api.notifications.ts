import { and, eq } from "drizzle-orm";
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications";
import { db } from "~/db";
import { notifications, users } from "~/db/schema";
import { activeInbox } from "~/lib/notification-retention.server";
import { requireUserId } from "~/lib/access.server";
import {
  getInbox,
  presentNotification,
  recipientNotification,
} from "~/lib/notifications.server";

async function recipient(request: Request) {
  const id = await requireUserId(request);
  if (!db.select().from(users).where(eq(users.id, id)).get())
    throw data("Sign in required", { status: 401 });
  return id;
}
export async function loader({ request }: Route.LoaderArgs) {
  return getInbox(request, await recipient(request));
}
const mutationSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("mark-all") }),
  z.object({
    intent: z.enum(["read", "unread", "open"]),
    id: z.coerce.number().int().positive(),
  }),
]);
export async function action({ request }: Route.ActionArgs) {
  const userId = await recipient(request);
  const parsed = mutationSchema.safeParse(
    Object.fromEntries(await request.formData())
  );
  if (!parsed.success)
    throw data("Invalid notification action", { status: 400 });
  const input = parsed.data;
  if (input.intent === "mark-all") {
    db.update(notifications)
      .set({ readAt: new Date().toISOString() })
      .where(activeInbox(userId))
      .run();
    return { ok: true, destination: null };
  }
  const item = recipientNotification(input.id, userId);
  if (!item) throw data("Notification unavailable", { status: 404 });
  const presented =
    input.intent === "open" ? await presentNotification(request, item) : null;
  if (input.intent === "open" && !presented?.destination)
    throw data("Notification unavailable", { status: 404 });
  const updated = db
    .update(notifications)
    .set({
      readAt: input.intent === "unread" ? null : new Date().toISOString(),
    })
    .where(and(eq(notifications.id, item.id), activeInbox(userId)))
    .run();
  if (!updated.changes) throw data("Notification unavailable", { status: 404 });
  return { ok: true, destination: presented?.destination ?? null };
}
