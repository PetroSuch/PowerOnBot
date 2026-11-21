# Schedule Watcher Bot

A Telegram bot that monitors Lvivoblenergo outage schedules for the groups selected in each chat. It sends alerts when the selected schedules change or when tomorrow’s schedule becomes available.

## Setup

For local development, create a `.env` file next to `package.json` with your token from BotFather:

```dotenv
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
```

Run `npm ci` once, then `npm start` from the project root. Restart the bot after updating `.env`.

You can also supply `BOT_TOKEN` through the shell. A shell value takes precedence over `.env`.

PowerShell:

```powershell
npm ci
$env:BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN"
npm start
```

Bash:

```bash
npm ci
export BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"
npm start
```

`npm start` builds the project and starts the bot. Use `npm run dev` to compile TypeScript as you edit.

## Telegram commands

- `/start` prompts you to select outage groups and enables alerts after you save them.
- `/groups_list` shows your selected groups.
- `/add_group` adds groups. For example, send `/add_group 1.1; 3.2`.
- `/remove_group` removes groups. For example, send `/remove_group 1.1`. Remove all groups to stop receiving alerts.
- `/check` fetches the current schedules for your groups.

## Configuration

The bot checks shortly after startup and then at a random interval between 15 and 20 minutes. It saves each chat’s settings and schedule snapshots in `label-state.json` in the project root.

| Environment variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | Required Telegram bot token from BotFather. |
| `CHECK_EVERY_MS` | Fixed check interval in milliseconds, for example `300000` for five minutes. |
| `CHECK_EVERY_MIN_MS`, `CHECK_EVERY_MAX_MS` | Bounds for the random interval when a fixed interval is unset. |
| `LOE_MENU_TYPE` | Lvivoblenergo menu type. Defaults to `photo-grafic`. |
| `LOE_MENUS_URL` | Optional override for the [default schedule endpoint](https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic). |
