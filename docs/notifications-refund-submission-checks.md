# Refund Request submission checks (#12)

The automated seam uses real authenticated Refund Request actions, inbox loaders and buyer/Platform Admin destination loaders against migrated isolated SQLite. It covers receipts, multiple current Platform Admins, actor suppression, event-time membership, distinct requests, duplicate submission rejection, partial-recipient rollback/retry, ownership changes, deleted targets, direct route access and the existing post-commit email failure boundary. A Team Licence buyer can select the specific request without Enrollment; the review destination follows its current status after a decision.

The notification stores recipient, actor, event, Refund Request reference, time and read state. It does not snapshot the reason, email or course title. Receipt and review entries share a submission event key; the recipient uniqueness constraint retains a Platform Admin buyer's receipt while suppressing their own review alert. Existing email transport and content remain unchanged.

## Manual browser checks still to perform

1. Submit an eligible Individual Purchase Refund Request, then navigate/reload as the buyer and each Platform Admin. The buyer sees one receipt; each other current Platform Admin sees one review alert. A Platform Admin buyer gets their receipt only.
2. Repeat with a Team Licence buyer who has no Enrollment. Open the receipt and verify that Settings selects and scrolls to the actual Refund Request, with its reason and current decision note.
3. Open the Platform Admin alert after a different Platform Admin has decided the request. The review screen selects the specific request and uses its current status filter.
4. Open a receipt after approval ends Enrollment. The specific Settings request remains accessible, and the notification grants no course content access.
5. Verify opening the popover preserves unread state; opening one destination marks that entry only. Read/unread and Mark all as read persist through navigation/reload.
6. Remove the recipient's Platform Admin role or remove a target. On navigation/reload, the entry becomes unavailable without stale context; opening it fails and the direct review route denies a former Platform Admin.

These are pending manual acceptance checks, not claims of completed browser validation. The user approved server verification plus documenting this browser gap.
