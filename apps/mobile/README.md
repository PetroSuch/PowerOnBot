# PowerOn mobile PWA

The app displays today's and tomorrow's schedules and can show the last cached schedule offline. The mobile API saves group preferences and an optional display name per installation. The same profile keeps its preferences when notifications are disabled.

## Run locally

Run the commands below from the repository root.

```sh
npm run build
npm run start:mobile-api
```

Set `DATABASE_URL` in the root `.env` or `.env.local`. Open `http://127.0.0.1:8080` to use the built app with its service worker. For UI development, run `npm run dev:mobile` in a separate terminal. Its API proxy uses port 8080. The Angular development build leaves the service worker disabled.

## Enable Web Push

Generate a server key pair once from the repository root with `npx --no-install web-push generate-vapid-keys`. Add these settings to the root `.env`.

```dotenv
PWA_PORT=8080
DATABASE_URL=postgresql://user:password@localhost:5432/poweron
VAPID_SUBJECT=mailto:contact@example.com
VAPID_PUBLIC_KEY=YOUR_PUBLIC_KEY
VAPID_PRIVATE_KEY=YOUR_PRIVATE_KEY
```

The server creates `mobile_devices`, `mobile_device_groups`, and `mobile_push_subscriptions` in PostgreSQL. It sends an alert when a selected schedule changes or tomorrow's schedule appears. The first start copies anonymous subscriptions from the previous PWA. Reuse the same public origin and VAPID key pair to keep existing browser installations connected.

The server uses `DATABASE_URL` for application queries and `DATABASE_URL_UNPOOLED` for schema setup when provided. Exported environment variables take precedence, followed by `.env.local` and `.env`. On Render, use `node apps/mobile-server/dist/index.js` as the start command and set `PWA_HOST=0.0.0.0`. The mobile backend uses Render’s `PORT`.

For phones, serve the built app and API at the same HTTPS origin. Use `PWA_HOST=0.0.0.0` when deploying behind a hosting platform's HTTPS reverse proxy. On iPhone or iPad with iOS or iPadOS 16.4 or later, add PowerOn to the Home Screen, open it from there, choose a group, and tap **Увімкнути**. Home Screen installation and Web Push require no Apple Developer Program membership. [WebKit's PWA and Web Push guide](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
