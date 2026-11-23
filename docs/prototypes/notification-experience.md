# Notification experience prototype

Throwaway primary source for [Explore the notification inbox and preference experience](https://github.com/ameow/cadence-project/issues/4). No direction has been accepted yet.

Run `npm run dev`, select a user and country in the floating DevUI panel if prompted, then open:

- `/dashboard?variant=A`: bell popover over the existing dashboard.
- `/dashboard?variant=B`: side drawer alongside existing courses.
- `/dashboard?variant=C`: inbox workspace with courses as a secondary view.

The bottom bar and left/right arrow keys cycle between variants. The prototype is enabled only during development with a `variant` query parameter. The dashboard's real loader, auth and course data remain in place.

Use Preview role to inspect example Student, Instructor and Platform Admin notifications. The selector changes sample notifications, not the signed-in account. Try unread/read, empty and load-error scenarios; opening a destination preview marks that entry read. Try marking it unread and marking all read. Each reply remains a separate entry. Destination previews show proposed routes and anchors, not working deep links or real request records.

Email settings model optional lesson emails and, for Platform Admins, separate new Refund Request alert emails. Buyer receipt and decision emails stay mandatory. Save success and failure are simulated; draft and saved preferences appear in the state disclosure. Everything lives in memory and resets on reload. No messages are sent and no provider is connected.

## Proposed interaction choices to discuss

- Bell badge shows unread count; zero removes the badge. Load error uses an unavailable indicator rather than claiming zero.
- Opening the inbox does not mark everything read. Opening a destination marks only its entry read; explicit read/unread controls and Mark all as read are available.
- All and Unread filters; newest entries first, with actor, event, course/lesson or Purchase context, time and a destination action.
- Lesson destinations focus the question/reply; Platform Admin alerts focus a Refund Request; buyer confirmations focus their own Refund Request in Settings. These targets will need implementation support.
- Email settings are accessible from the inbox. Whether they should also live in the existing Settings page remains for discussion.

The accepted layout, interactions and any changes to these proposals must be recorded after live human feedback. Keep the decision ticket open until then. This branch is a prototype asset and should not be merged or promoted to production UI.

## Verification

Run the repository's required checks in order: `npm run typecheck`, then `npm run test`. Visual verification is pending: this session has no connected browser, and native Chrome/Visual Studio Code access reports that Computer Use permissions are not granted.
