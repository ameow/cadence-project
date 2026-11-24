import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Bell, X } from "lucide-react";
import type { loader } from "~/routes/api.notifications";
import { formatRelativeTime } from "~/lib/utils";

type Inbox = Awaited<ReturnType<typeof loader>>;

/** Navigation is the only automatic refresh trigger. Mutations update this snapshot. */
export function NotificationBell({ userId }: { userId: number }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState(false);
  const [mutationError, setMutationError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const generation = useRef(0);
  const panel = useRef<HTMLDivElement>(null);

  async function refresh(signal?: AbortSignal) {
    const current = ++generation.current;
    setError(false);
    try {
      const response = await fetch("/api/notifications", { signal });
      if (!response.ok) throw new Error("Inbox unavailable");
      const value: Inbox = await response.json();
      if (current === generation.current) setInbox(value);
    } catch {
      if (!signal?.aborted && current === generation.current) setError(true);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setOpen(false);
    setInbox(null);
    void refresh(controller.signal);
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [location.key, userId]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function outside(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target)
      )
        setOpen(false);
    }
    document.addEventListener("keydown", dismiss);
    document.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("mousedown", outside);
    };
  }, [open]);

  async function mutate(
    intent: "read" | "unread" | "mark-all" | "open",
    id?: number
  ) {
    const current = generation.current;
    setBusy(true);
    setMutationError(false);
    try {
      const body = new URLSearchParams({ intent });
      if (id !== undefined) body.set("id", String(id));
      const response = await fetch("/api/notifications", {
        method: "POST",
        body,
      });
      if (!response.ok) throw new Error("Notification action failed");
      const result: { destination: string | null } = await response.json();
      if (current !== generation.current) return;
      setInbox((previous) => {
        if (!previous) return previous;
        const items = previous.items.map((item) =>
          intent === "mark-all" || item.id === id
            ? {
                ...item,
                readAt: intent === "unread" ? null : new Date().toISOString(),
              }
            : item
        );
        return {
          items,
          unreadCount: items.filter((item) => item.readAt === null).length,
        };
      });
      if (result.destination) {
        setOpen(false);
        navigate(result.destination);
      }
    } catch {
      if (current === generation.current) setMutationError(true);
    } finally {
      setBusy(false);
    }
  }

  const items =
    inbox?.items.filter((item) => filter === "all" || item.readAt === null) ??
    [];
  return (
    <div ref={panel} className="relative z-40">
      <button
        type="button"
        className="relative rounded-full border bg-background p-3 shadow-sm"
        aria-label={`Notifications${error ? ", unavailable" : inbox ? `, ${inbox.unreadCount} unread` : ", loading"}`}
        aria-expanded={open}
        aria-controls="notification-inbox"
        onClick={() => setOpen(!open)}
      >
        <Bell className="size-5" />
        {(error || (inbox?.unreadCount ?? 0) > 0) && (
          <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
            {error ? "!" : inbox?.unreadCount}
          </span>
        )}
      </button>
      {open && (
        <section
          id="notification-inbox"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-background shadow-xl"
        >
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold">Notifications</h2>
            <button
              aria-label="Close notifications"
              onClick={() => setOpen(false)}
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="flex items-center gap-3 border-b px-4 py-3 text-sm">
            <button
              aria-pressed={filter === "all"}
              className={filter === "all" ? "font-semibold text-primary" : ""}
              onClick={() => setFilter("all")}
            >
              All
            </button>
            <button
              aria-pressed={filter === "unread"}
              className={
                filter === "unread" ? "font-semibold text-primary" : ""
              }
              onClick={() => setFilter("unread")}
            >
              Unread
            </button>
            <button
              className="ml-auto text-xs text-primary"
              disabled={busy || !inbox?.unreadCount}
              onClick={() => void mutate("mark-all")}
            >
              Mark all as read
            </button>
          </div>
          {error ? (
            <div role="alert" className="p-6 text-sm">
              Couldn’t load notifications.{" "}
              <button
                className="text-primary underline"
                onClick={() => void refresh()}
              >
                Retry
              </button>
            </div>
          ) : !inbox ? (
            <p className="p-6 text-sm text-muted-foreground">
              Loading notifications…
            </p>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {filter === "unread"
                ? "You’re all caught up."
                : "No notifications yet."}
            </div>
          ) : (
            <ul className="max-h-[28rem] divide-y overflow-y-auto">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={`p-4 ${item.readAt === null ? "bg-primary/5" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    {item.readAt === null && (
                      <span
                        aria-label="Unread"
                        className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{item.title}</p>
                      {item.context && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.context}
                        </p>
                      )}
                      <time
                        dateTime={item.createdAt}
                        className="mt-1 block text-xs text-muted-foreground"
                      >
                        {formatRelativeTime(item.createdAt)}
                      </time>
                      <div className="mt-3 flex gap-4 text-xs text-primary">
                        {item.destination && (
                          <button
                            disabled={busy}
                            onClick={() => void mutate("open", item.id)}
                          >
                            Open notification
                          </button>
                        )}
                        <button
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              item.readAt ? "unread" : "read",
                              item.id
                            )
                          }
                        >
                          {item.readAt ? "Mark as unread" : "Mark as read"}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {mutationError && (
            <p role="alert" className="border-t p-3 text-sm text-destructive">
              Couldn’t update this notification. Please try the control again.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
