# PowerOnBot

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
| `/check` | Requests a refresh and shows the latest available schedules. Each Telegram user can request a refresh once every 10 minutes. The reply includes the schedule's last update time when available and the next manual refresh time. |

Send `/add_group` or `/remove_group` without arguments to have the bot prompt you for the group IDs.

## How it works

1. **Receive Telegram updates.** The TypeScript app uses Telegraf to receive commands and replies through long polling. Run one polling instance per bot token.
2. **Fetch schedules.** The first automatic check is scheduled about two seconds after startup. It checks for subscribed chats, then refreshes one shared snapshot. The default delay between scheduled passes is a random 15–20 minutes. Scheduled passes and manual refreshes share any in-flight request and wait at least 10 minutes after a request completes before contacting Lvivoblenergo again.
3. **Read the selected groups.** The bot looks for the `Today` and `Tomorrow` menu items. Cheerio extracts text from the mobile HTML and falls back to the regular HTML if it cannot read the mobile schedule. The bot parses group IDs once per fetch and matches them against each chat's selection.
4. **Send updates.** The bot establishes a baseline for today's schedule, compares selected group schedules by Kyiv calendar date, and announces tomorrow's schedule when it first becomes available for those groups. A failed fetch or malformed response leaves the last successful snapshot available for viewing.
5. **Save state.** The bot loads and updates `label-state.json` in the project root. It stores Telegram chat IDs, group selections, alert settings, notification baselines, and manual cooldowns. The shared feed snapshot and upstream cooldown live in memory for the running process.

The startup log reports how many chat records were loaded. Invalid or unreadable state stops startup. If you update the file while the bot is running, restart the bot to load the changes.

To verify upstream traffic, look for `[LOE] Upstream fetch #… started` in the server logs. Each of those lines represents one request, regardless of the subscriber count. Checks that join a running fetch or use the cache have separate log lines. Fetch numbers restart with the process.

## Run locally

Use Node.js 20.18.1 or later with npm. Create a `.env` file next to `package.json` with your token from BotFather.

```dotenv
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
```

From the project root, install dependencies and start the bot.

```sh
npm ci
npm start
```

`npm start` builds the TypeScript and runs the compiled bot with Nodemon. Use `npm run dev` to recompile TypeScript as you edit, or `npm test` to run the mocked regression tests. Restart the bot after updating `.env`.

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
