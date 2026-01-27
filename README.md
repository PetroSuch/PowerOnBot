# Schedule Watcher Bot

Telegram bot that checks the schedule page and extracts `.periods_items`. It stores **City / Address / HouseNumber per chat** and compares the latest `.periods_items` HTML with the last saved one:

- If it’s the **same**: no notification
- If it’s **different**: sends a Telegram message that it changed

## Setup

## Quick commands

### Dev / run

```bash
npm install
export BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"
npm run dev
```

### Production-ish run

```bash
npm install
npm run build
BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN" npm start
```

### Optional: change check interval

```bash
# e.g. 5 minutes
export CHECK_EVERY_MS=300000
```

### Optional: choose LOE API menu type / URL

```bash
# default is photo-grafic (contains rawHtml/rawMobileHtml with schedules)
export LOE_MENU_TYPE="photo-grafic"

# or set an explicit URL
export LOE_MENUS_URL="https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic"
```

1. Install deps:

```bash
npm install
```

2. Export your bot token:

```bash
export BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN"
```

3. Run:

```bash
npm run dev
```

## Using the bot

- `/start` — show help
- `/help` — show help (alias)
- `/set City, Address, HouseNumber` — save your parameters for this chat
  - Also accepted: `/set City | Address | HouseNumber`
- `/watch` — enable notifications in the current chat (saved to `label-state.json`)
- `/unwatch` — disable notifications
- `/status` — show last check time / errors / URL
- `/check` — manual check right now

## Notes

- State is persisted in `label-state.json` in the project root.
- The bot checks every **CHECK_EVERY_MS** (default **15 minutes**) and once shortly after startup.

