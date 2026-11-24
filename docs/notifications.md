# Notification inbox

Ticket #10 implements the first event: a Student's top-level lesson question alerts the owning Instructor, excluding the actor. An enrolled non-owning Instructor takes the Student role for this course. The comment and entry commit in the same SQLite transaction. Owning Instructor/Platform Admin posts, replies, edits and deletions do not emit this event. Later tickets extend the event matrix and add retention; they are not implemented here.

`notifications` stores event keys, recipient/actor/comment references, creation time and nullable read time. It stores no copied content or email addresses. `(eventKey, recipientId)` is unique. Question keys are `comment:<commentId>`, kind `lesson-question`. `insertNotifications(tx, entries)` lets domain transactions re-emit an event without duplicating it or resetting its read state. The recipient foreign key cascades deletion; any future account-removal workflow must delete the account's inbox in its transaction and account for other domain references. No account-removal UI is introduced.

`/api/notifications` authenticates GET and POST independently. GET returns the current recipient's items and unread count. POST supports `read`, `unread`, `open` with a positive `id`, and `mark-all`. Client recipient identifiers never grant access. Opening resolves destination access again before marking only that entry read and returning its URL. Presentation also resolves current access and uses generic unavailable text for deleted or inaccessible targets. Course ownership changes do not move historical rows. Read/unread controls remain available on unavailable entries.

The shared bell appears on signed-in home and app pages, including lessons. Its snapshot refreshes on navigation/reload and explicit load-error retry. Opening, changing filters and read mutations do not refetch new activity. Raw fetch keeps framework action revalidation from introducing an extra refresh. Mutations update the visible snapshot after successful persistence. No focus listener, polling, queue, external delivery or email send is added. Each actual rendered comment has a `comment-<id>` anchor.

For reply work, preserve the historical fact that a thread was Student-started rather than inferring it from its author's later role. For refund work, extend destination references and presentation with current buyer/Platform Admin authorization. Retention/cleanup and production operational gates belong to #14.

## Verification

Real authenticated route tests run against isolated SQLite databases with the generated migrations. They cover creation, transaction failure/retry, distinct events/uniqueness, recipient isolation (including Platform Admin attacks), authentication on every operation, read controls, actual lesson destinations, current access, event-time ownership, soft-deleted targets and non-emitting actions. Development seed creates local question entries using existing seeded discussion references.

Browser verification was not performed: Computer Use is not approved and no browser surface is available. The user authorized proceeding with server checks and documenting this gap. The following acceptance checks remain manual:

- Select an Instructor, inspect the bell on home, dashboard and a lesson. Verify compact layout, unread badge, All/Unread, read styling, empty states, keyboard dismissal and narrow screens.
- Post a Student question in another session. Confirm a stationary inbox stays unchanged, including after unrelated action revalidation and tab return. Navigate/reload and confirm the new item/count appears.
- Open the popover repeatedly; verify no read changes. Mark one item read/unread and mark all read; reload to verify persistence. Open one question and confirm only its entry becomes read and the actual question anchor is visible/highlighted.
- Remove ownership or delete a question. Navigate/reload and verify generic unavailable text and no old context; direct opening must not bypass current authorization.
- Block the inbox request in browser developer tools, navigate, open the bell, verify load error/unavailable badge, unblock and Retry. Block POST separately and confirm a read-control failure preserves its visible state and allows retry.
