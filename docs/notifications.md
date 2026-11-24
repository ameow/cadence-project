# Notification inbox

Notifications use application-owned SQLite persistence, the shared signed-in bell and per-recipient read state. Each domain change and its complete eligible recipient set commit in one transaction; inbox write failure rolls back both and sends no post-commit buyer email. Re-emitting the same domain event preserves uniqueness and read state. Distinct events remain separate entries.

| Committed event | In-app recipients |
| --- | --- |
| Student posts a top-level lesson question | Course's owning Instructor |
| Owning Instructor or Platform Admin replies to a Student-started question | Student who asked |
| Student replies to a Student-started question | Student who asked and owning Instructor |
| Buyer submits a Refund Request | Every current Platform Admin and the buyer receipt confirmation |
| Refund Request is approved or declined | Purchase buyer decision confirmation |

Suppress the actor's own entry except buyer receipt and decision confirmations. A Platform Admin buyer retains their own buyer confirmations. Only Student-started lesson threads qualify; other participants, staff-started threads, edits and deletions emit no lesson entries. An enrolled non-owning Instructor takes the Student role for the course. Resolve Instructor ownership and Platform Admin membership at event time; later changes do not transfer historical entries. Subsequent events use current membership/ownership.

Buyer destinations authorize current Purchase ownership and support Individual Purchases and Team Licences, including after approval ends Enrollment. Platform Admin review destinations require the current role. Approval copy confirms acceptance of the Refund Request, never that money has been issued or arrived. Existing Refund Request emails remain independent of inbox read state, are sent only after commit and retain existing failure handling; there are no new emails, retries or recovery.

`notifications` stores event keys, recipient/actor/comment/Refund Request references, creation time and nullable read time. It stores no copied content or email addresses. `(eventKey, recipientId)` is unique. Question keys are `comment:<commentId>`, kind `lesson-question`. `insertNotifications(tx, entries)` lets domain transactions re-emit an event without duplicating it or resetting its read state. The recipient foreign key cascades deletion; any future account-removal workflow must delete the account's inbox in its transaction and account for other domain references. No account-removal UI is introduced.

`/api/notifications` authenticates GET and POST independently. GET returns the current recipient's items and unread count. POST supports `read`, `unread`, `open` with a positive `id`, and `mark-all`. Client recipient identifiers never grant access. Opening resolves destination access again before marking only that entry read and returning its URL. Presentation also resolves current access and uses generic unavailable text for deleted or inaccessible targets. Course ownership changes do not move historical rows. Read/unread controls remain available on unavailable entries.

The shared bell appears on signed-in home and app pages, including lessons. Its snapshot refreshes on navigation/reload and explicit load-error retry. Opening, changing filters and read mutations do not refetch new activity. Raw fetch keeps framework action revalidation from introducing an extra refresh. Mutations update the visible snapshot after successful persistence. No focus listener, polling, queue, external delivery or email send is added. Each actual rendered comment has a `comment-<id>` anchor.

The historical fact that a thread was Student-started is preserved independently of its author's later role. Current destination authorization applies to all lesson and Refund Request entries; inaccessible or deleted content is presented generically. All event kinds use the shared retention policy below.

## Verification

Real authenticated route tests run against isolated SQLite databases with the generated migrations. They cover creation, transaction failure/retry, distinct events/uniqueness, recipient isolation (including Platform Admin attacks), authentication on every operation, read controls, actual lesson destinations, current access, event-time ownership, soft-deleted targets and non-emitting actions. Development seed creates local question entries using existing seeded discussion references.

Browser verification was not performed: Computer Use is not approved and no browser surface is available. The user authorized proceeding with server checks and documenting this gap. The following acceptance checks remain manual:

- Select an Instructor, inspect the bell on home, dashboard and a lesson. Verify compact layout, unread badge, All/Unread, read styling, empty states, keyboard dismissal and narrow screens.
- Post a Student question in another session. Confirm a stationary inbox stays unchanged, including after unrelated action revalidation and tab return. Navigate/reload and confirm the new item/count appears.
- Open the popover repeatedly; verify no read changes. Mark one item read/unread and mark all read; reload to verify persistence. Open one question and confirm only its entry becomes read and the actual question anchor is visible/highlighted.
- Post owning Instructor/Platform Admin and Student replies through both posting screens; verify the recipient matrix, separate reply entries and the actual reply anchor. Submit and decide Refund Requests for Individual Purchases and Team Licences; verify buyer/admin recipients, buyer destinations without Enrollment, truthful approval copy and shared read controls. Confirm new events appear only after navigation/reload.
- Remove ownership or delete a question. Navigate/reload and verify generic unavailable text and no old context; direct opening must not bypass current authorization.
- Block the inbox request in browser developer tools, navigate, open the bell, verify load error/unavailable badge, unblock and Retry. Block POST separately and confirm a read-control failure preserves its visible state and allows retry.

## Shared lifecycle and daily cleanup

All notification kinds expire exactly 90 × 24 hours after `createdAt`, using UTC timestamps. The shared `activeInbox` predicate excludes entries at or before the cutoff from the authenticated inbox list and its unread count, individual read/unread/open lookup and updates, and mark-all. All and Unread are views of that same returned list. Expired entries cannot open a destination through the inbox, even while physical rows remain. The underlying destination retains its own access rules.

The existing navigation/manual reload freshness contract still applies: a stationary browser can retain its earlier snapshot, including across expiry. The next navigation/reload removes expired entries and refreshes the count. Server requests always apply the current cutoff, so an expired entry in an older browser snapshot is rejected by read/open mutations. No expiry polling or timer has been added.

Run `npm run notifications:purge` from the application directory with the application's migrated `data.db` and the same filesystem identity. The command invokes `purgeExpiredNotifications()` against the application database, removes rows created at or before the current 90-day cutoff, and reports only the number removed. It is safe to repeat and preserves younger rows. A deployment operator must schedule this command once daily, monitor exit status/failure and arrange reruns; this change provisions no scheduler or services. Delayed cleanup does not extend live visibility. This is database maintenance, not a delivery/retry worker. Local verification uses migrated isolated SQLite with a controlled clock and directly calls this same entry point through `withDatabase`.

The recipient foreign key uses `ON DELETE CASCADE`; actor and destination references may become null. The account-removal integration contract is to delete the account row within the future account-removal transaction after satisfying other domain references, with foreign keys enabled. This removes every notification received by the account, including unexpired/read entries, while retaining other recipients' history and clearing any removed actor reference. An isolated database test exercises that contract. There is no account-deletion product flow yet; its eventual integration must preserve the transaction/cascade and backup-deletion policy.

## Production deployment gates

These requirements are unverified deployment prerequisites, not claims about configured production infrastructure:

- Verify EU placement and processing for the live SQLite file, host, logs, snapshots, backups and any operational tooling touching notification data. Record providers, regions and any transfers before deployment.
- Restrict exceptional database access to authorized operators, with least privilege and access auditing. Prefer aggregate counts, timestamps and failure categories for diagnostics; avoid notification contents, recipient identifiers or exported inboxes. There is no inbox-inspection UI. Routine application/maintenance logs must exclude notification content and email addresses; purge output is only a deletion count. Review error collection and database tooling for accidental SQL parameter/content capture.
- Define encrypted backups, restricted access, backup frequency and retention/deletion schedules, including account-deletion handling. Verify a restore procedure and recovery objectives. After restore, run expiry cleanup before serving traffic and reconcile account deletions made since the restored snapshot so removed inboxes do not reappear. Immediate live expiry is not erasure from retained backups; document the actual backup erasure timeline and exceptional restore access.
- Replace development identity selection with hardened production authentication/session handling, secure cookie and session configuration, and appropriate authorization checks. Isolate or disable DevUI and development user-switching in production; no operator should gain arbitrary inbox access through these development facilities.
- Assess application storage, indexes, SQLite write contention, purge duration, backup growth and hosting cost using expected event/recipient fan-out and a 90-day window. Monitor actual capacity and growth through minimal aggregate diagnostics. Historical provider-volume examples and a $30/month plus Postmark target are not adopted requirements. Capacity/cost assessment belongs to normal application planning.

## Retention verification and remaining browser acceptance

Controlled-time authenticated route tests cover immediately before/at expiry across all kinds, All/Unread data and counts while expired rows remain, expired individual actions, and mark-all preservation. Cleanup tests exercise the daily entry point against the same isolated migrated database, preserving younger rows and checking repeated runs. Storage remains references, timestamps and read state: no question bodies, Refund Request reasons or email snapshots are introduced.

Browser checks remain unperformed under the user-authorized server-only verification noted above. In addition to the shared manual checks, prepare a locally seeded entry immediately before 90 days, observe All/Unread and its count, then cross expiry without cleanup. Confirm the stationary snapshot follows the accepted freshness contract; navigate and separately reload to confirm the expired entry and count disappear together. Attempt open/read from an older snapshot and verify unavailable/failure handling. Run the cleanup command and repeat navigation/reload; younger entries and their persisted read state must remain. Repeat with a reply and Refund Request entry to verify the shared popover behavior. These checks are an explicit acceptance gap, not a completed browser test.
