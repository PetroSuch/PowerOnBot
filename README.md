# PowerOnBot

## Project structure

The repository uses npm workspaces and a single root `package-lock.json`.

| Workspace | Purpose | Run from the repository root |
| --- | --- | --- |
| `apps/mobile` | Angular PWA with group selection, outage schedules, and Web Push | `npm run dev:mobile` on port 4200 |
| `apps/web` | Angular web app for the shared outage schedule | `npm run dev:web` on port 4201 |
| `apps/admin` | Angular admin panel for Telegram and Web Push subscriptions | `npm run dev:admin` on port 4202 |
| `apps/telegram-server` | Existing Telegram bot and schedule fetcher | `npm run dev:telegram` |
| `packages/shared` | Shared TypeScript schedule types and outage group IDs | `npm run build:shared` |

Use Node.js 24 with npm. Run `npm ci` once from the repository root, `npm run build` to build all workspaces, and `npm test` to run the schedule and Web Push regression tests. The three Angular apps can run independently.

Set `PWA_PORT=8080` to serve the built apps and API from the same backend. The mobile PWA is at `/`, the public web app at `/web/`, and the admin panel at `/admin/`. All browser clients use the server API. Only the server uses `DATABASE_URL`.

The web app and PWA share the account page at `/account.html`. A verified account can share its selected groups with a linked Telegram chat and registered Web Push devices. The public schedule and existing anonymous subscriptions continue to work.

For account access, configure `POWERON_AUTH_URL` (the public HTTPS origin), `BETTER_AUTH_SECRET` (a random secret of at least 32 characters), and `DATABASE_URL`. You can also set `DATABASE_URL_UNPOOLED` for migrations. Use the same origin for mobile, web, admin and API in production.

- To enable Google sign-in, create a **Web application** OAuth client in Google Cloud. Add `http://127.0.0.1:8080/api/auth/callback/google` for local testing and the same path on your public HTTPS origin for production under **Authorized redirect URIs**. Copy the credentials into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in your server environment. [Better Auth Google setup](https://better-auth.com/docs/authentication/google)
- To enable email and password sign-in, set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` (a verified sender). An existing password user can link a Google account with the same email from their signed-in profile. Admin access requires a verified password account and TOTP.

For local account testing, build all workspaces and open the apps through the combined backend at `http://127.0.0.1:8080`. Set `PWA_PORT=8080` and `POWERON_AUTH_URL=http://127.0.0.1:8080` for that environment.

To grant the first administrator role, create and verify the person's account, then run `node apps/telegram-server/dist/index.js --grant-admin admin@example.com` using the production environment. The administrator enrolls an authenticator on the account page and verifies a TOTP code when signing in. The shared `ADMIN_API_TOKEN` is no longer used. Web Push still requires VAPID keys. [Mobile setup](apps/mobile/README.md)

## Telegram bot

PowerOnBot is a Telegram bot that monitors Lvivoblenergo's scheduled power outages. Each chat can follow one or more outage groups, see the latest published schedules on demand, and receive alerts when a followed group's schedule changes or tomorrow's schedule becomes available. Messages show the selected groups and include a link to the published schedule image when available.

## Using the bot

Send `/start` in Telegram and reply with your outage groups, for example `1.1; 3.2`. The bot saves the selection, enables alerts, and shows the saved schedule if one is available. Use `/check` to request an update. It supports groups `1.1` through `6.2`, with two groups per number, and accepts both `1.1` and `1,1` as input.

| Command | What it does |
| --- | --- |
| `/start` | Prompts you to choose or replace the chat's groups and enables alerts after you save them. |
| `/groups_list` | Shows the chat's selected groups. |
| `/add_group 1.1; 3.2` | Adds groups and shows any saved schedules for them. In a new chat, finish `/start` to enable automatic alerts. |
| `/remove_group 1.1` | Removes groups. Remove all groups to stop receiving alerts. |
| `/schedule` | Shows the latest saved schedules for the chat's groups without making an upstream request. |
| `/check` | Shows the latest available schedules and refreshes the shared cache when the server's 10-minute interval has elapsed. The reply includes the last update time when available and the earliest time the server can fetch again. |

Send `/add_group` or `/remove_group` without arguments to have the bot prompt you for the group IDs.

## How it works

1. **Receive Telegram updates.** The TypeScript app uses Telegraf to receive commands and replies through long polling. Run one polling instance per bot token.
2. **Fetch schedules.** The first automatic check is scheduled about two seconds after startup. It checks for subscribed chats, then refreshes one shared snapshot. The default delay between scheduled passes is a random 15–20 minutes. Scheduled passes and manual refreshes share any in-flight request and wait at least 10 minutes after a request completes before contacting Lvivoblenergo again.
3. **Read the selected groups.** The bot looks for the `Today` and `Tomorrow` menu items. Cheerio extracts text from the mobile HTML and falls back to the regular HTML if it cannot read the mobile schedule. The bot parses group IDs once per fetch and matches them against each chat's selection.
4. **Send updates.** The bot establishes a baseline for today's schedule, compares selected group schedules by Kyiv calendar date, and announces tomorrow's schedule when it first becomes available for those groups. A failed fetch or malformed response leaves the last successful snapshot available for viewing.
5. **Save state.** With `DATABASE_URL` configured, one PostgreSQL database stores the latest schedule, the successful refresh cooldown, Telegram chat settings, and Web Push subscriptions. The server restores the latest schedule after restart. On the first run for a bot, it imports existing records from `label-state.json` if present. Without a database URL, the bot uses the local file and keeps the schedule in memory.

The startup log reports the data source and how many chat records were loaded. To import the local file into the configured database without starting Telegram polling, run `npm run build` and then `node apps/telegram-server/dist/index.js --import-telegram-state`. Repeating the command loads the existing database state. When using local storage, restart the bot after editing the file.

To verify upstream traffic, look for `[LOE] Upstream fetch #… started` in the server logs. Each of those lines represents one request, regardless of the subscriber count. Checks that join a running fetch or use the cache have separate log lines. Fetch numbers restart with the process.

## Run locally

Create a `.env` file in the repository root with your token from BotFather.

```dotenv
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
```

From the project root, install dependencies and start the bot.

```sh
npm ci
npm start
```

`npm start` builds and runs the Telegram bot with Nodemon. Use `npm run dev:telegram` to recompile it as you edit. `npm run dev` is an alias for the same command. Restart the bot after updating `.env`.

You can also supply `BOT_TOKEN` through your shell, which takes precedence over `.env`.

- PowerShell uses `$env:BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN"`.
- Bash uses `export BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"`.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | Required Telegram bot token from BotFather. |
| `CHECK_EVERY_MS` | Fixed check interval in milliseconds, for example `300000` for five minutes. |
| `CHECK_EVERY_MIN_MS`, `CHECK_EVERY_MAX_MS` | Random interval bounds in milliseconds. Defaults to `900000` and `1200000` (15 and 20 minutes). |
| `LOE_MENU_TYPE` | Lvivoblenergo menu type. Defaults to `photo-grafic`. |
| `LOE_MENUS_URL` | Optional override for the [default schedule endpoint](https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic). |
