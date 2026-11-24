import { purgeExpiredNotifications } from "../app/lib/notification-retention.server";

// Output only a maintenance count, never inbox contents or recipient identifiers.
console.log(`Expired notifications removed: ${purgeExpiredNotifications()}`);
