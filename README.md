# PowerOnBot

## Project structure

The repository uses npm workspaces and a single root `package-lock.json`.

| Workspace | Purpose | Run from the repository root |
| --- | --- | --- |
| `apps/mobile` | Angular PWA with group selection, outage schedules, and Web Push | `npm run dev:mobile` on port 4200 |
| `apps/mobile-server` | Mobile HTTP API, device profiles, schedule cache, and Web Push | `npm run start:mobile-api` on port 8080 after building |
| `apps/web` | Angular web app for the shared outage schedule | `npm run dev:web` on port 4201 |
| `apps/admin` | Angular admin panel for Telegram and Web Push subscriptions | `npm run dev:admin` on port 4202 |
| `apps/telegram-server` | Standalone Telegram bot backed by `label-state.json` | `npm start` or `npm run dev:telegram` |
| `packages/shared` | Schedule types, fetcher, and Web Push schedule comparison shared by both backends | `npm run build:shared` |

Use Node.js 24 with npm. Run `npm ci` once from the repository root, `npm run build` to build all workspaces, and `npm test` to run the schedule and Web Push regression tests. The three Angular apps can run independently.

## Run the two backends

1. Run `npm run build` from the repository root.
2. Run `npm start` in one terminal for Telegram. It uses `BOT_TOKEN` and the existing `label-state.json`.
3. Run `npm run start:mobile-api` in another terminal. It uses `DATABASE_URL` and serves the built PWA and API at `http://127.0.0.1:8080`. The public web schedule is at `/web/`. See the [mobile setup](apps/mobile/README.md) for Web Push and hosting.

If both run, set `TELEGRAM_SCHEDULE_URL=http://127.0.0.1:8080` or the mobile backend’s HTTPS origin in the Telegram environment. The mobile backend then owns requests to Lvivoblenergo and shares one 10-minute cooldown across mobile and Telegram. Without this setting the standalone bot fetches schedules directly and keeps its own cache in memory.

The mobile backend stores a device profile, its selected groups, and its optional Web Push subscription in Neon. Users can set an optional display name in the **Профіль** screen. Each installation uses a random token stored in its browser or PWA, and the server stores a hash of that token. Clearing site data or changing origins creates a new installation identity.

### Legacy web and admin

The old web and admin paths can be served with `node apps/telegram-server/dist/index.js --combined` and `PWA_PORT`. Run that compatibility mode on its own because it also starts Telegram polling. Its legacy account and admin APIs use their original data. The standalone mobile backend has a device profile API and does not serve the legacy account or admin routes.

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
5. **Save state.** The standalone bot stores chat groups, monitoring settings, and notification history in the root `label-state.json`, even if `DATABASE_URL` is set for the mobile backend.

The startup log reports how many chat records were loaded. Stop the bot before editing the file and restart it to load your changes.

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
| `TELEGRAM_SCHEDULE_URL` | Optional mobile backend origin for using its shared schedule cache. |
| `CHECK_EVERY_MS` | Fixed check interval in milliseconds, for example `300000` for five minutes. |
| `CHECK_EVERY_MIN_MS`, `CHECK_EVERY_MAX_MS` | Random interval bounds in milliseconds. Defaults to `900000` and `1200000` (15 and 20 minutes). |
| `LOE_MENU_TYPE` | Lvivoblenergo menu type. Defaults to `photo-grafic`. |
| `LOE_MENUS_URL` | Optional override for the [default schedule endpoint](https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic). |
