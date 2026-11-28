# PowerOn mobile PWA

The app remembers the selected outage groups on the device, displays today's and tomorrow's schedules, and uses the same 10-minute refresh cache as Telegram. It can display the last cached schedule offline.

## Run locally

Run the commands below from the repository root.

```sh
npm run build
npm start
```

Set `PWA_PORT=8080` in the root `.env` before starting. Open `http://localhost:8080` to use the built app with its service worker. For UI development, run `npm run dev:mobile` in a separate terminal. Its API proxy uses port 8080. The Angular development build leaves the service worker disabled.

## Enable Web Push

Generate a server key pair once from the repository root with `npx --no-install web-push generate-vapid-keys`. Add these settings to the root `.env`.

```dotenv
PWA_PORT=8080
DATABASE_URL=postgresql://user:password@localhost:5432/poweron
VAPID_SUBJECT=mailto:contact@example.com
VAPID_PUBLIC_KEY=YOUR_PUBLIC_KEY
VAPID_PRIVATE_KEY=YOUR_PRIVATE_KEY
```

The server creates the `pwa_push_devices` table on startup. It saves device subscriptions and selected groups in PostgreSQL and sends an alert when a selected schedule changes or tomorrow's schedule appears. Keep the private key in the server environment and reuse the same key pair across deployments.

For the linked Neon project, run `neon deploy` to pull database credentials into `.env` or `.env.local`. The server uses `DATABASE_URL` for application queries and `DATABASE_URL_UNPOOLED` for schema setup when provided. Exported environment variables take precedence, followed by `.env.local` and `.env`. Configure the same database variables as server secrets on Render when deploying.

For phones, serve the built app and API at the same HTTPS origin. Use `PWA_HOST=0.0.0.0` when deploying behind a hosting platform's HTTPS reverse proxy. On iPhone or iPad with iOS or iPadOS 16.4 or later, add PowerOn to the Home Screen, open it from there, choose a group, and tap **Увімкнути**. Home Screen installation and Web Push require no Apple Developer Program membership. [WebKit's PWA and Web Push guide](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
