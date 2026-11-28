# PowerOnBot implementation plan

Start with the shared schedule fetcher. It fixes the Telegram bot’s duplicate API calls immediately and gives the mobile app and admin panel one source of schedule data.

## 1. Fetch the schedule once and notify subscribers

**Status:** Implemented in the Telegram bot and verified with mocked upstream and Telegram responses.

- Extract the Lvivoblenergo fetcher and parser from the Telegram bot. Each scheduled run fetches the feed once, parses today’s and tomorrow’s schedules, and shares the result across all chats.
- Fix the parser to handle adjacent HTML blocks and comma-form group IDs. Keep the last successful snapshot if the upstream request fails or the response is malformed.
- Compare schedules by group and Kyiv calendar date. Notify subscribers when their groups change or tomorrow’s schedule appears.

**Done when** a scheduled run for 100 subscribed chats makes one upstream request, and processing the same snapshot twice produces no duplicate alerts.

## 2. Enforce the shared 10-minute refresh cooldown

**Status:** Implemented for Telegram. `/schedule` reads the cache, and `/check` uses the shared refresh service. The mobile client can use this service once the backend API is added.

- Make `/check` and the future app’s **Refresh** button use the same backend refresh logic. Users can view the latest saved schedule at any time.
- Enforce a **10-minute server-wide cooldown** on upstream requests. During the cooldown, return the shared schedule, its last update time, and the next eligible fetch time.
- If a fetch is already running, reuse that result. Apply the same rule to scheduled and manual refreshes.

**Done when** repeated requests from one user or simultaneous requests from many users cannot trigger extra upstream calls.

## 3. Move state to PostgreSQL

- Store users, Telegram chat links, group subscriptions, schedule snapshots, refresh timestamps, device push tokens, and notification delivery records.
- Write an idempotent import for `label-state.json` that preserves existing chats, groups, and alert settings. Back up the file before cutover.
- Save schedule changes and enqueue notifications in the same transaction. Give each delivery a unique key so retries and worker restarts do not create duplicate jobs.

**Done when** the bot can restart with its subscriptions, cooldowns, and pending notifications intact.

## 4. Deploy the shared backend

Use **Render** for the first deployment. Run the TypeScript API as a Web Service, run schedule polling and notification delivery in a Background Worker, and use managed Render Postgres. The existing Telegram bot can keep running as a single long-polling instance. [Render service types](https://render.com/docs/service-types) · [Render Postgres](https://render.com/docs/postgresql-creating-connecting)

Expose authenticated endpoints for schedule reads, refresh requests, group preferences, and device registration. Track the last successful upstream fetch and failed notification deliveries so you can diagnose problems after deployment.

**Done when** the deployed API serves the saved schedule and the worker can fetch and deliver alerts independently of user requests.

## 5. Build the iOS and Android app

If **App Store and Google Play downloads** are part of the goal, use **Expo with React Native**. Build one app with group selection, today’s and tomorrow’s schedules, the refresh countdown, and notification preferences. Use Expo Push Service for delivery and EAS Submit to upload builds to the stores. [Expo push notifications](https://docs.expo.dev/push-notifications/overview/) · [Expo store submission](https://docs.expo.dev/deploy/submit-to-app-stores)

If **installation from a link** is enough, a PWA is a viable first release. On iOS and iPadOS, Web Push requires version 16.4 or later and installation to the Home Screen. [WebKit Web Push guide](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

**Done when** a user on a real iPhone and Android device can select a group and receive a test notification with the app closed.

## 6. Build the admin panel

- Let authenticated admins search users, edit group subscriptions, and enable or disable notifications by channel.
- Show the latest schedule fetch, notification history, and failed deliveries. Allow targeted test notifications and retries of failed deliveries.
- Record administrative changes with the actor and timestamp.

**Done when** an admin can update a user’s groups, verify the change in the app or Telegram, and see the outcome of the next relevant notification.
