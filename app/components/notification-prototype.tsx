// THROWAWAY: three notification layouts on /dashboard?variant=A|B|C.
// Question: quick bell popover, persistent drawer, or dedicated inbox workspace?
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Bell, X, Settings2 } from "lucide-react";
import { Button } from "~/components/ui/button";

type Role = "Student" | "Instructor" | "Platform Admin";
type Notice = {
  id: number;
  title: string;
  text: string;
  context: string;
  time: string;
  destination: string;
  target: string;
};
const samples: Record<Role, Notice[]> = {
  Student: [
    {
      id: 1,
      title: "Maya replied to your question",
      text: "Try narrowing the union before accessing the property.",
      context: "TypeScript Essentials · Narrowing · Your question",
      time: "2 minutes ago",
      destination: "View reply",
      target: "/courses/:slug/lessons/:lessonId#reply-:id",
    },
    {
      id: 2,
      title: "Leo replied to your question",
      text: "I found the same example helpful too.",
      context: "TypeScript Essentials · Narrowing · Your question",
      time: "4 minutes ago",
      destination: "View reply",
      target: "/courses/:slug/lessons/:lessonId#reply-:id",
    },
    {
      id: 3,
      title: "Your Refund Request was approved",
      text: "Your request has been accepted. This confirms the decision; it does not confirm that the money has arrived.",
      context: "React Foundations · Individual Purchase",
      time: "1 hour ago",
      destination: "View Refund Request",
      target: "/settings#refund-request-:id",
    },
    {
      id: 4,
      title: "We received your Refund Request",
      text: "A Platform Admin will review your request.",
      context: "React Foundations · Individual Purchase",
      time: "Yesterday",
      destination: "View Refund Request",
      target: "/settings#refund-request-:id",
    },
    {
      id: 5,
      title: "Your Refund Request was declined",
      text: "Your course access stays the same. View the decision note for details.",
      context: "Practical CSS · Individual Purchase",
      time: "2 days ago",
      destination: "View Refund Request",
      target: "/settings#refund-request-:id",
    },
  ],
  Instructor: [
    {
      id: 6,
      title: "Ava asked a lesson question",
      text: "When should I use a discriminated union?",
      context: "TypeScript Essentials · Narrowing",
      time: "2 minutes ago",
      destination: "View question",
      target: "/instructor/questions?question=:id",
    },
    {
      id: 7,
      title: "Ava replied to a lesson question",
      text: "Would this work with an optional property?",
      context: "TypeScript Essentials · Narrowing · Ava’s question",
      time: "8 minutes ago",
      destination: "View reply",
      target: "/instructor/questions?question=:id#reply-:id",
    },
  ],
  "Platform Admin": [
    {
      id: 8,
      title: "New Refund Request from Ava",
      text: "The course was not the right fit for me.",
      context: "React Foundations · Individual Purchase · €49",
      time: "2 minutes ago",
      destination: "Review Refund Request",
      target: "/admin/refunds?request=:id",
    },
    {
      id: 9,
      title: "New Refund Request from Rowan",
      text: "Our plans for the course have changed.",
      context: "Practical CSS · Team Licence · €149",
      time: "18 minutes ago",
      destination: "Review Refund Request",
      target: "/admin/refunds?request=:id",
    },
  ],
};
const names = { A: "Bell popover", B: "Side drawer", C: "Inbox workspace" };
type Variant = keyof typeof names;

export function NotificationPrototype({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const candidate = params.get("variant");
  const variant: Variant =
    candidate === "B" || candidate === "C" ? candidate : "A";
  const active = import.meta.env.DEV && candidate !== null;
  const [role, setRole] = useState<Role>("Student");
  const [read, setRead] = useState<number[]>([5]);
  const [open, setOpen] = useState(true);
  const [preferences, setPreferences] = useState(false);
  const [lessonEmail, setLessonEmail] = useState(true);
  const [refundEmail, setRefundEmail] = useState(true);
  const [savedEmail, setSavedEmail] = useState({ lessonEmail: true, refundEmail: true });
  const [scenario, setScenario] = useState("mixed");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<Notice | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const notices = scenario === "empty" ? [] : samples[role];
  const isRead = (id: number) => scenario === "read" || read.includes(id);
  const unread = notices.filter((n) => !isRead(n.id)).length;
  const shown = notices.filter((n) => !unreadOnly || !isRead(n.id));

  function cycle(direction: number) {
    const keys: Variant[] = ["A", "B", "C"];
    const next = new URLSearchParams(params);
    next.set("variant", keys[(keys.indexOf(variant) + direction + 3) % 3]);
    setParams(next, { replace: true });
    setOpen(true);
  }
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input,textarea,select,[contenteditable]")
      )
        return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        cycle(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  if (!active) return children;

  const list = (
    <section
      aria-label="Notifications"
      className="overflow-hidden rounded-xl border bg-background shadow-lg"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
        <h2 className="text-xl font-semibold">
          Notifications{" "}
          <span className="text-sm text-muted-foreground">
            {scenario === "error" ? "" : `${unread} unread`}
          </span>
        </h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPreferences(!preferences)}
          >
            <Settings2 className="size-4" /> Email settings
          </Button>
          {variant !== "C" && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close notifications"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          )}
        </div>
      </div>
      <div className="flex justify-between gap-2 border-b p-3 text-sm">
        <div className="flex gap-3">
          <button
            className={!unreadOnly ? "font-bold underline" : ""}
            onClick={() => setUnreadOnly(false)}
          >
            All
          </button>
          <button
            className={unreadOnly ? "font-bold underline" : ""}
            onClick={() => setUnreadOnly(true)}
          >
            Unread
          </button>
        </div>
        <button
          disabled={!unread || scenario === "error"}
          className="underline disabled:opacity-40"
          onClick={() => setRead(samples[role].map((n) => n.id))}
        >
          Mark all as read
        </button>
      </div>
      <div className="max-h-[52vh] overflow-y-auto">
        {scenario === "error" ? (
          <div role="alert" className="p-8 text-center">
            <p className="font-medium">Notifications couldn’t load</p>
            <p className="my-3 text-sm text-muted-foreground">
              Try again to see your latest updates.
            </p>
            <Button onClick={() => setScenario("mixed")}>Try again</Button>
          </div>
        ) : shown.length === 0 ? (
          <div className="p-10 text-center">
            <Bell className="mx-auto mb-3 size-8 text-muted-foreground" />
            <h3 className="font-medium">
              {notices.length ? "You’re all caught up" : "No notifications yet"}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {notices.length
                ? "Your read notifications are in All."
                : "Replies and Refund Request updates will appear here."}
            </p>
          </div>
        ) : (
          shown.map((notice) => (
            <article
              key={notice.id}
              className={`border-b p-4 ${isRead(notice.id) ? "" : "bg-primary/5"}`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-2 size-2 shrink-0 rounded-full ${isRead(notice.id) ? "bg-transparent" : "bg-primary"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <h3
                      className={
                        isRead(notice.id) ? "font-medium" : "font-bold"
                      }
                    >
                      {notice.title}
                    </h3>
                    <span className="text-xs text-muted-foreground">
                      {isRead(notice.id) ? "Read" : "Unread"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {notice.context} · {notice.time}
                  </p>
                  <p className="my-2 text-sm">{notice.text}</p>
                  <div className="flex flex-wrap justify-between gap-3 text-sm">
                    <button
                      className="font-medium underline"
                      onClick={() => {
                        setSelected(notice);
                        setRead([...read, notice.id]);
                      }}
                    >
                      {notice.destination} →
                    </button>
                    <button
                      className="text-muted-foreground underline"
                      onClick={() => {
                        if (scenario === "read") {
                          setScenario("mixed");
                          setRead(
                            samples[role]
                              .filter((n) => n.id !== notice.id)
                              .map((n) => n.id)
                          );
                        } else
                          setRead(
                            isRead(notice.id)
                              ? read.filter((id) => id !== notice.id)
                              : [...read, notice.id]
                          );
                      }}
                    >
                      Mark as {isRead(notice.id) ? "unread" : "read"}
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
  const settings = preferences && (
    <section
      className="rounded-xl border bg-background p-5 shadow-lg"
      aria-label="Email preferences"
    >
      <h2 className="text-lg font-semibold">Notification emails</h2>
      <p className="my-3 text-sm text-muted-foreground">
        In-app notifications are always on. Reading a notification does not
        cancel its email.
      </p>
      <label className="my-4 flex items-center justify-between gap-4">
        Lesson activity emails
        <input
          type="checkbox"
          checked={lessonEmail}
          onChange={(e) => {
            setLessonEmail(e.target.checked);
            setSaveStatus("");
          }}
        />
      </label>
      {role === "Platform Admin" && (
        <label className="my-4 flex items-center justify-between gap-4">
          New Refund Request alert emails
          <input
            type="checkbox"
            checked={refundEmail}
            onChange={(e) => {
              setRefundEmail(e.target.checked);
              setSaveStatus("");
            }}
          />
        </label>
      )}
      <p className="mb-4 rounded-lg bg-muted p-3 text-sm">
        Always sent: your buyer receipt and decision confirmations for Refund
        Requests.
      </p>
      <Button
        onClick={() => {
          if (!saveError) setSavedEmail({ lessonEmail, refundEmail });
          setSaveStatus(
            saveError
              ? "Couldn’t save. Your previous preferences still apply. Try again."
              : "Preferences saved for this demo session."
          );
        }}
      >
        Save preferences
      </Button>
      <p role="status" className="mt-3 text-sm">
        {saveStatus}
      </p>
    </section>
  );

  return (
    <>
      <div className="border-b bg-muted/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest">
              Throwaway prototype · {names[variant]}
            </p>
            <p className="text-sm text-muted-foreground">
              Example notifications; changes reset on reload.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setOpen(!open)}
            aria-label={
              scenario === "error"
                ? "Open notifications, unread count unavailable"
                : `Open notifications, ${unread} unread`
            }
          >
            <Bell className="size-4" /> Notifications{" "}
            {scenario === "error" ? (
              "!"
            ) : unread > 0 ? (
              <span className="rounded-full bg-primary px-2 text-primary-foreground">
                {unread}
              </span>
            ) : null}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <label>
            Preview role{" "}
            <select
              className="rounded border bg-background p-1"
              value={role}
              onChange={(e) => {
                setRole(e.target.value as Role);
                setRead([5]);
                setSelected(null);
              }}
            >
              {Object.keys(samples).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            State{" "}
            <select
              className="rounded border bg-background p-1"
              value={scenario}
              onChange={(e) => {
                setScenario(e.target.value);
                setRead([5]);
              }}
            >
              <option value="mixed">Unread + read</option>
              <option value="empty">Empty</option>
              <option value="read">All read</option>
              <option value="error">Load error</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={saveError}
              onChange={(e) => setSaveError(e.target.checked)}
            />{" "}
            Simulate preference save failure
          </label>
        </div>
      </div>
      {variant === "A" && (
        <>
          <div className="relative z-20">
            {open && (
              <div className="absolute right-4 top-2 w-[min(94%,460px)] space-y-3">
                {list}
                {settings}
              </div>
            )}
          </div>
          {children}
        </>
      )}
      {variant === "B" && (
        <div className="flex flex-col xl:flex-row">
          <div className="min-w-0 flex-1">{children}</div>
          {open && (
            <aside className="w-full space-y-3 border-l p-4 xl:w-[440px] xl:shrink-0">
              {list}
              {settings}
            </aside>
          )}
        </div>
      )}
      {variant === "C" && (
        <div className="p-6">
          <div className="mb-4 flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => setOpen(true)}>
              Notifications
            </Button>
            <Button variant="outline" onClick={() => setOpen(false)}>
              My courses
            </Button>
          </div>
          {open ? (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(240px,1fr)]">
              {list}
              <div className="space-y-4">
                <div className="rounded-xl border p-5">
                  <h3 className="font-semibold">Your notification inbox</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Each question, reply or Refund Request update appears
                    separately. Use Unread to catch up.
                  </p>
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={() => setPreferences(true)}
                  >
                    Email settings
                  </Button>
                </div>
                {settings}
              </div>
            </div>
          ) : (
            children
          )}
        </div>
      )}
      {selected && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Destination preview"
            className="w-full max-w-lg rounded-xl bg-background p-6 shadow-xl"
          >
            <h2 className="text-xl font-semibold">{selected.destination}</h2>
            <p className="my-3">{selected.context}</p>
            <p>{selected.text}</p>
            <p className="my-4 break-all rounded bg-muted p-3 text-sm">
              Proposed destination: {selected.target}
            </p>
            <p className="mb-4 text-sm text-muted-foreground">
              Opening an entry marks it read. This is a destination preview with
              sample IDs; deep links will be implemented later.
            </p>
            <Button autoFocus onClick={() => setSelected(null)}>
              Back to inbox
            </Button>
          </section>
        </div>
      )}
      <details className="mx-6 mb-24 mt-6 rounded border p-3 text-xs">
        <summary>Prototype state</summary>
        <pre className="overflow-auto">
          {JSON.stringify(
            {
              variant,
              role,
              scenario,
              unread: scenario === "error" ? "unknown" : unread,
              read,
              unreadOnly,
              open,
              lessonEmail,
              refundEmail,
              savedEmail,
              saveError,
              saveStatus,
              destination: selected?.target ?? null,
            },
            null,
            2
          )}
        </pre>
      </details>
      <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 whitespace-nowrap rounded-full bg-foreground px-4 py-3 text-sm text-background shadow-xl">
        <button aria-label="Previous variant" onClick={() => cycle(-1)}>
          ←
        </button>
        <span>
          {variant} · {names[variant]}
        </span>
        <button aria-label="Next variant" onClick={() => cycle(1)}>
          →
        </button>
      </div>
    </>
  );
}
