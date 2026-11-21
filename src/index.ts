import { Telegraf } from 'telegraf';
import { load } from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';

type IsoDateString = string;

type LoeMenuItem = {
  id: number;
  name: string;
  slug: string;
  imageUrl: string;
  description: string;
  rawHtml: string;
  rawMobileHtml: string;
};

type LoeMenu = {
  id: number;
  name: string;
  type: string;
  menuItems: LoeMenuItem[];
};

type LoeMenusResponse = LoeMenu[] | {
  'hydra:member'?: LoeMenu[];
};

const POSSIBLE_GROUPS = [
  '1.1',
  '1.2',
  '2.1',
  '2.2',
  '3.1',
  '3.2',
  '4.1',
  '4.2',
  '5.1',
  '5.2',
  '6.1',
  '6.2',
] as const;

type PossibleGroup = (typeof POSSIBLE_GROUPS)[number];

type UserState = {
  // New LOE "group" tracking
  groups?: string[]; // e.g. ["1.1", "3.2"]
  pendingStep?: 'groups' | 'groups_add' | 'groups_remove';

  watching: boolean;

  // LOE-based tracking snapshot (for watched groups)
  lastLoeCheckedAt?: IsoDateString;
  lastLoeNotifiedAt?: IsoDateString;
  lastLoeWatchedText?: string;
  lastLoeError?: string;

  // LOE "Tomorrow" tracking snapshot (for watched groups)
  lastLoeTomorrowCheckedAt?: IsoDateString;
  lastLoeTomorrowNotifiedAt?: IsoDateString;
  lastLoeTomorrowWatchedText?: string;
  lastLoeTomorrowStatus?: 'missing' | 'present';
  lastLoeTomorrowError?: string;
};

type BotState = {
  users: Record<string, UserState>;
};

const STATE_FILE_PATH = path.join(process.cwd(), 'label-state.json');
try {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

// Scheduling:
// - By default, checks run on a randomized cadence between 15 and 20 minutes.
// - For backwards-compatibility, you can pin a fixed cadence by setting CHECK_EVERY_MS.
const DEFAULT_CHECK_EVERY_MIN_MS = 15 * 60 * 1000;
const DEFAULT_CHECK_EVERY_MAX_MS = 20 * 60 * 1000;
const FIXED_CHECK_EVERY_MS = process.env.CHECK_EVERY_MS ? Number(process.env.CHECK_EVERY_MS) : undefined;
if (FIXED_CHECK_EVERY_MS !== undefined && (!Number.isFinite(FIXED_CHECK_EVERY_MS) || FIXED_CHECK_EVERY_MS <= 0)) {
  throw new Error('CHECK_EVERY_MS must be a positive number (milliseconds)');
}
const CHECK_EVERY_MIN_MS = Number(process.env.CHECK_EVERY_MIN_MS ?? DEFAULT_CHECK_EVERY_MIN_MS);
const CHECK_EVERY_MAX_MS = Number(process.env.CHECK_EVERY_MAX_MS ?? DEFAULT_CHECK_EVERY_MAX_MS);
if (!Number.isFinite(CHECK_EVERY_MIN_MS) || CHECK_EVERY_MIN_MS <= 0) {
  throw new Error('CHECK_EVERY_MIN_MS must be a positive number (milliseconds)');
}
if (!Number.isFinite(CHECK_EVERY_MAX_MS) || CHECK_EVERY_MAX_MS <= 0) {
  throw new Error('CHECK_EVERY_MAX_MS must be a positive number (milliseconds)');
}
if (CHECK_EVERY_MIN_MS > CHECK_EVERY_MAX_MS) {
  throw new Error('CHECK_EVERY_MIN_MS must be <= CHECK_EVERY_MAX_MS');
}

function randomIntInclusive(min: number, max: number): number {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function nextCheckDelayMs(): number {
  if (FIXED_CHECK_EVERY_MS !== undefined) return FIXED_CHECK_EVERY_MS;
  return randomIntInclusive(CHECK_EVERY_MIN_MS, CHECK_EVERY_MAX_MS);
}

function formatInterval(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} секунд`;
  const min = Math.round(sec / 60);
  return `${min} хвилин`;
}

function formatIntervalRange(minMs: number, maxMs: number): string {
  if (minMs === maxMs) return formatInterval(minMs);
  return `${formatInterval(minMs)}–${formatInterval(maxMs)}`;
}

function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, ' ').trim();
}

function normalizeMultilineText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

function absoluteLoeMediaUrl(pathname: string): string {
  if (!pathname) return '';
  if (/^https?:\/\//i.test(pathname)) return pathname;
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `https://api.loe.lviv.ua${p}`;
}

function extractGroupLinesOnly(text: string): string {
  return normalizeMultilineText(text)
    .split('\n')
    .filter((l) => /^Група\s+\d+[.,]\d+\./i.test(l))
    .join('\n')
    .trim();
}

function textFromRawHtml(rawHtml: string): string {
  if (!rawHtml) return '';
  const $ = load(rawHtml);
  return normalizeMultilineText($.text());
}

function normalizeGroupId(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // Accept both dot and comma between numbers: 1.1 or 1,1
  const m = s.match(/^(\d+)[.,](\d+)$/);
  if (!m) return null;
  return `${Number(m[1])}.${Number(m[2])}`;
}

function parseGroupsFromUserInput(raw: string): string[] {
  // Extract group-like tokens from free-form input.
  // Supports separators: comma or dot inside group id (1,1 or 1.1)
  // Supports multiple groups in one message using ";" (or any other text).
  const out: string[] = [];
  const re = /(\d+)[.,](\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const g = normalizeGroupId(`${m[1]}.${m[2]}`);
    if (g && !out.includes(g)) out.push(g);
  }
  // Validate against known possible groups
  return out.filter((g) => (POSSIBLE_GROUPS as readonly string[]).includes(g));
}

function formatPossibleGroups(): string {
  return [
    'Доступні групи:',
    '1.1, 1.2',
    '2.1, 2.2',
    '3.1, 3.2',
    '4.1, 4.2',
    '5.1, 5.2',
    '6.1, 6.2',
  ].join('\n');
}

function parseGroupSchedulesFromText(text: string): Record<string, string> {
  // Input example lines (from LOE rawHtml):
  // "Група 1.1. Електроенергії немає з 05:30 до 09:00, з 16:00 до 19:30."
  const lines = normalizeMultilineText(text).split('\n');
  const map: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/Група\s+(\d+\.\d+)\./i);
    if (!m) continue;
    const g = normalizeGroupId(m[1]);
    if (!g) continue;
    map[g] = line;
  }
  return map;
}

async function fetchLoePhotoGraficMenuItems(): Promise<{
  menuName: string;
  sourceUrl: string;
  today?: { item: LoeMenuItem; itemText: string; imageUrl: string };
  tomorrow?: { item: LoeMenuItem; itemText: string; imageUrl: string };
}> {
  const defaultType = 'photo-grafic';
  const type = String(process.env.LOE_MENU_TYPE ?? defaultType);
  const sourceUrl = String(
    process.env.LOE_MENUS_URL ?? `https://api.loe.lviv.ua/api/menus?page=1&type=${encodeURIComponent(type)}`,
  );

  const res = await fetch(sourceUrl, {
    headers: {
      accept: 'application/ld+json,application/json;q=0.9,*/*;q=0.8',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} when calling LOE API`);
  }

  const data = (await res.json()) as LoeMenusResponse | null;
  const menus = Array.isArray(data) ? data : data?.['hydra:member'];
  const menu = menus?.[0];
  if (!menu || !Array.isArray(menu.menuItems)) {
    throw new Error('LOE API response did not contain a menu with menuItems');
  }

  const todayItem = menu.menuItems.find((item: LoeMenuItem) => item.name === 'Today');
  const tomorrowItem = menu.menuItems.find((item: LoeMenuItem) => item.name === 'Tomorrow');
 
  const today = todayItem
    ? {
        item: todayItem,
        itemText: textFromRawHtml(todayItem.rawMobileHtml || todayItem.rawHtml),
        imageUrl: absoluteLoeMediaUrl(todayItem.imageUrl || todayItem.slug),
      }
    : undefined;

  const tomorrow = tomorrowItem
    ? {
        item: tomorrowItem,
        itemText: textFromRawHtml(tomorrowItem.rawMobileHtml || tomorrowItem.rawHtml),
        imageUrl: absoluteLoeMediaUrl(tomorrowItem.imageUrl || tomorrowItem.slug),
      }
    : undefined;

  return { menuName: menu.name, sourceUrl, today, tomorrow };
}

async function readStateFromDisk(): Promise<BotState> {
  try {
    const raw = await fs.readFile(STATE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'users' in parsed &&
      typeof (parsed as any).users === 'object' &&
      (parsed as any).users !== null
    ) {
      return normalizeStateShape(parsed as any);
    }
    return { users: {} };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { users: {} };
    // If JSON is corrupt, don't crash the bot — start fresh.
    return { users: {} };
  }
}

function normalizeStateShape(input: any): BotState {
  const rawUsers = input?.users && typeof input.users === 'object' ? (input.users as Record<string, any>) : {};
  const users: Record<string, UserState> = {};

  for (const [chatId, raw] of Object.entries(rawUsers)) {
    const u = raw && typeof raw === 'object' ? (raw as any) : {};
    const pending =
      u.pendingStep === 'groups' || u.pendingStep === 'groups_add' || u.pendingStep === 'groups_remove'
        ? (u.pendingStep as UserState['pendingStep'])
        : undefined;
    
    users[chatId] = {
      groups: Array.isArray(u.groups) ? u.groups.filter((x: any) => typeof x === 'string') : undefined,
      pendingStep: pending,
      watching: Boolean(u.watching),
      lastLoeCheckedAt: typeof u.lastLoeCheckedAt === 'string' ? u.lastLoeCheckedAt : undefined,
      lastLoeNotifiedAt: typeof u.lastLoeNotifiedAt === 'string' ? u.lastLoeNotifiedAt : undefined,
      lastLoeWatchedText: typeof u.lastLoeWatchedText === 'string' ? u.lastLoeWatchedText : undefined,
      lastLoeError: typeof u.lastLoeError === 'string' ? u.lastLoeError : undefined,

      lastLoeTomorrowCheckedAt: typeof u.lastLoeTomorrowCheckedAt === 'string' ? u.lastLoeTomorrowCheckedAt : undefined,
      lastLoeTomorrowNotifiedAt:
        typeof u.lastLoeTomorrowNotifiedAt === 'string' ? u.lastLoeTomorrowNotifiedAt : undefined,
      lastLoeTomorrowWatchedText:
        typeof u.lastLoeTomorrowWatchedText === 'string' ? u.lastLoeTomorrowWatchedText : undefined,
      lastLoeTomorrowStatus:
        u.lastLoeTomorrowStatus === 'missing' || u.lastLoeTomorrowStatus === 'present'
          ? (u.lastLoeTomorrowStatus as UserState['lastLoeTomorrowStatus'])
          : undefined,
      lastLoeTomorrowError: typeof u.lastLoeTomorrowError === 'string' ? u.lastLoeTomorrowError : undefined,
    };
  }

  return { users };
}

async function writeStateToDisk(state: BotState): Promise<void> {
  const normalized = normalizeStateShape(state as any);
  const tmp = `${STATE_FILE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8');
  await fs.rename(tmp, STATE_FILE_PATH);
}

const token = process.env.BOT_TOKEN?.trim();
if (!token) {
  throw new Error('Вкажіть BOT_TOKEN у файлі .env поруч із package.json або в змінних середовища.');
}

const bot = new Telegraf(token);

let state: BotState = { users: {} };
let stateOp: Promise<unknown> = Promise.resolve();
function runStateOp<T>(fn: () => Promise<T>): Promise<T> {
  const next = stateOp.then(fn, fn);
  stateOp = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function ensureUser(chatId: string): Promise<UserState> {
  if (!state.users[chatId]) state.users[chatId] = { watching: false };
  return state.users[chatId];
}

async function checkOneChat(chatId: string, user: UserState, forceCheck: boolean = false): Promise<void> {
  if (!user.watching && !forceCheck) return;
  if (!user.groups || user.groups.length === 0) {
    user.lastLoeError = 'Не задано групи. Використайте /add_group, наприклад: /add_group 1.1, 3.2';
    user.lastLoeCheckedAt = new Date().toISOString();
    await writeStateToDisk(state);
    if (forceCheck) {
      await bot.telegram.sendMessage(chatId, user.lastLoeError);
    }
    return;
  }
  
  try {
    const { today, tomorrow } = await fetchLoePhotoGraficMenuItems();
    user.lastLoeCheckedAt = new Date().toISOString();
    user.lastLoeError = undefined;
    user.lastLoeTomorrowCheckedAt = user.lastLoeCheckedAt;
    user.lastLoeTomorrowError = undefined;

    if (today?.itemText) {
      // ---- TODAY ----
      const groupMap = parseGroupSchedulesFromText(today.itemText);
      const selectedLines = user.groups
        .map((g) => groupMap[g] ?? `Група ${g}. (Не знайдено в оновленні)`);
  
      // Keep the top 2 lines if present (usually "Графік ...", "Інформація станом ...")
      const headerLines = normalizeMultilineText(today.itemText)
        .split('\n')
        .slice(0, 2)
        .filter((l) => l.length > 0);
  
      const watchedText = [...headerLines, '', ...selectedLines].join('\n').trim();
      const watchedGroupsText = selectedLines.join('\n').trim();
      const prev = user.lastLoeWatchedText ? extractGroupLinesOnly(user.lastLoeWatchedText) : undefined;
      const isNotifiedYesterday = user.lastLoeNotifiedAt ? new Date(user.lastLoeNotifiedAt).getDate() !== new Date().getDate() : false;
  
      const formattedSelectedLines = selectedLines
          .map((line) => line + '\n')
          .map((line) => line.replace(/,/g, '\n'))
          .map((line) => line.replace('Електроенергії немає', '\nЕлектроенергії немає:\n'))
          .map((line) => line.replace(/ з /g, 'з '));
      const watchedTextFormatted = [...headerLines, '', ...formattedSelectedLines].join('\n').trim();
  
      if (forceCheck || (prev && (prev !== watchedGroupsText || isNotifiedYesterday))) {
        await bot.telegram.sendMessage(
          chatId,
          [
            forceCheck ? '🔥 Оновлення перевірено!' : isNotifiedYesterday ? '🔥 Графік відключень на сьогодні!' : '🔥 Графік відключень на сьогодні змінився!',
            ' ',
            watchedTextFormatted || '(Не вдалося прочитати текст)',
            '',
            today.imageUrl ? `\n${prev ? 'Графік відключень на сьогодні' : 'Графік відключень'}: ${today.imageUrl}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        user.lastLoeWatchedText = watchedText;
        user.lastLoeNotifiedAt = new Date().toISOString();
        await writeStateToDisk(state);
      } else if (!prev) {
        user.lastLoeWatchedText = watchedText;
      }
    }

    const tomorrowGroupMap = parseGroupSchedulesFromText(tomorrow?.itemText ?? '');
    if (tomorrow && user.groups.some((g) => Boolean(tomorrowGroupMap[g]))) {
      const tomorrowSelectedLines = user.groups.map(
        (g) => tomorrowGroupMap[g] ?? `Група ${g}. (Не знайдено в графіку на завтра)`,
      );
      const tomorrowHeaderLines = normalizeMultilineText(tomorrow.itemText)
        .split('\n')
        .slice(0, 2)
        .filter((l) => l.length > 0);
      const previousTomorrowTitle = user.lastLoeTomorrowWatchedText?.split('\n')[0];
      const tomorrowWatchedText = [...tomorrowHeaderLines, '', ...tomorrowSelectedLines].join('\n').trim();
      const tomorrowWatchedGroupsText = tomorrowSelectedLines.join('\n').trim();
      const tomorrowPrevGroupsOnly = user.lastLoeTomorrowWatchedText
        ? extractGroupLinesOnly(user.lastLoeTomorrowWatchedText)
        : undefined;
  
      const appeared = user.lastLoeTomorrowStatus !== 'present';
      
      const formattedTomorrowSelectedLines = tomorrowSelectedLines
          .map((line) => line + '\n')
          .map((line) => line.replace(/,/g, '\n'))
          .map((line) => line.replace('Електроенергії немає', '\nЕлектроенергії немає:\n'))
          .map((line) => line.replace(/ з /g, 'з '));
      const tomorrowWatchedTextFormatted = [...tomorrowHeaderLines, '', ...formattedTomorrowSelectedLines].join('\n').trim();
  
      if (appeared || forceCheck || tomorrowPrevGroupsOnly !== tomorrowWatchedGroupsText || previousTomorrowTitle !== tomorrowHeaderLines[0]) {
        await bot.telegram.sendMessage(
          chatId,
          [
            appeared || forceCheck ? '🗓️ Зʼявився графік відключень на завтра!' : '🗓️ Графік відключень на завтра змінився!',
            ' ',
            tomorrowWatchedTextFormatted || '(Не вдалося прочитати текст)',
            '',
            tomorrow.imageUrl ? `\nГрафік (завтра): ${tomorrow.imageUrl}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        user.lastLoeTomorrowStatus = 'present';
        user.lastLoeTomorrowWatchedText = tomorrowWatchedText;
        user.lastLoeTomorrowNotifiedAt = new Date().toISOString();
      }
    } else {
      user.lastLoeTomorrowStatus = 'missing';
      user.lastLoeTomorrowWatchedText = undefined;
      if (forceCheck && !today?.itemText) {
        await bot.telegram.sendMessage(chatId, 'Графіки відключень на сьогодні й завтра наразі недоступні.');
      }
    }

    await writeStateToDisk(state);
  } catch (err: any) {
    user.lastLoeCheckedAt = new Date().toISOString();
    user.lastLoeError = err?.message ? String(err.message) : 'Невідома помилка під час перевірки графіка';
    await writeStateToDisk(state);
    if (forceCheck) {
      await bot.telegram.sendMessage(chatId, `❌ Помилка: ${user.lastLoeError}`);
    }
  }
}

async function checkAllWatchingChats(): Promise<void> {
  const entries = Object.entries(state.users);
  for (const [chatId, user] of entries) {
    await checkOneChat(chatId, user);
  }
}

async function checkLikeCheckCommand(ctx: any): Promise<void> {
  const chatId = String(ctx.chat.id);
  await ctx.reply('Перевіряю…');
  await runStateOp(async () => {
    const user = await ensureUser(chatId);
    await checkOneChat(chatId, user, true);
  });
}

async function watchLikeWatchCommand(ctx: any): Promise<void> {
  const chatId = String(ctx.chat.id);
  await runStateOp(async () => {
    const user = await ensureUser(chatId);
    user.watching = true;
    await writeStateToDisk(state);
  });

  await ctx.reply(
    'Перевірка відключень електроенергії увімкнена ✅\nЯ буду сповіщати вас, якщо графік відключень електроенергії зміниться.',
  );

  // Do an immediate baseline check (no notification on first snapshot)
  await runStateOp(async () => {
    const user = await ensureUser(chatId);
    await checkOneChat(chatId, user);
  });
}

async function promptForNextStep(ctx: any, step: UserState['pendingStep']): Promise<void> {
  if (step === 'groups') {
    await ctx.reply(
      [
        'Які групи відключень вас цікавлять?',
        'Можна вказати одну або декілька груп в одному повідомленні (через ;).',
        'Формат групи: 1.1 або 1,1',
        '',
        formatPossibleGroups(),
        '',
        'Приклад:',
        '1,1; 3.2; 4,2',
      ].join('\n'),
    );
    return;
  }
  if (step === 'groups_add') {
    await ctx.reply(
      ['Які групи додати?', 'Формат: 1.1 або 1,1', '', formatPossibleGroups(), '', 'Приклад: 1,1; 3.2'].join('\n'),
    );
    return;
  }
  if (step === 'groups_remove') {
    const currentGroups = state.users[String(ctx.chat.id)]?.groups ?? [];
    await ctx.reply(
      ['Які групи видалити?', '', 'Наразі вибрані групи: ' + currentGroups.join(', '), '', 'Приклад: 1,1; 3.2'].join('\n'),
    );
    return;
  }
}

bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);
  await runStateOp(async () => {
    const user = await ensureUser(chatId);
    user.pendingStep = 'groups';
    await writeStateToDisk(state);
  });
  await ctx.reply('Привіт!\nЯ чат-бот який вміє відстежувати графік погодинних відключень для вибраних груп та сповіщати, коли він зміниться.\nДодай групи відключень електроенергії та я буду сповіщати тебе, коли вони зміняться.');
  await promptForNextStep(ctx, 'groups');
  await checkLikeCheckCommand(ctx);
});

bot.command('groups_list', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = state.users[chatId];
  const groups = user?.groups ?? [];
  if (groups.length === 0) {
    await ctx.reply('Групи не задані. Використайте /add_group, наприклад: /add_group 1.1, 3.2');
    return;
  }
  await ctx.reply(`Ваші групи: ${groups.join(', ')}`);
});

async function addGroupCommand(ctx: any): Promise<void> {
  const chatId = String(ctx.chat.id);
  const tail = (ctx.message?.text ?? '')
    .replace(/^\/(add_group|groups_add)(@\w+)?/i, '')
    .trim();
  if (!tail) {
    await runStateOp(async () => {
      const user = await ensureUser(chatId);
      user.pendingStep = 'groups_add';
      await writeStateToDisk(state);
    });
    await promptForNextStep(ctx, 'groups_add');
    return;
  }

  const toAdd = parseGroupsFromUserInput(tail);
  if (toAdd.length === 0) {
    await ctx.reply(
      ['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: /add_group 1,1; 3.2'].join('\n'),
    );
    return;
  }

  await runStateOp(async () => {
    const user = await ensureUser(chatId);
    const current = user.groups ?? [];
    user.groups = [...current, ...toAdd].filter((g, idx, arr) => arr.indexOf(g) === idx);
    user.pendingStep = undefined;
    user.lastLoeWatchedText = undefined;
    user.lastLoeError = undefined;
    await writeStateToDisk(state);
  });

  const groups = state.users[chatId]?.groups ?? [];
  await ctx.reply(`Додано ✅\nВи відстежуєте такі групи відключень електроенергії: ${groups.join(', ')}`);
  await checkLikeCheckCommand(ctx);
}

bot.command('add_group', addGroupCommand);
// Backward-compatible alias
bot.command('groups_add', addGroupCommand);

async function removeGroupCommand(ctx: any): Promise<void> {
  const chatId = String(ctx.chat.id);
  const tail = (ctx.message?.text ?? '')
    .replace(/^\/(remove_group|groups_remove)(@\w+)?/i, '')
    .trim();
  if (!tail) {
    await runStateOp(async () => {
      const user = await ensureUser(chatId);
      user.pendingStep = 'groups_remove';
      await writeStateToDisk(state);
    });
    await promptForNextStep(ctx, 'groups_remove');
    return;
  }

  const toRemove = parseGroupsFromUserInput(tail);
  if (toRemove.length === 0) {
    await ctx.reply(
      ['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: /remove_group 1,1; 3.2'].join('\n'),
    );
    return;
  }

  await runStateOp(async () => {
    const user = await ensureUser(chatId);
    const current = user.groups ?? [];
    user.groups = current.filter((g) => !toRemove.includes(g));
    user.pendingStep = undefined;
    user.lastLoeWatchedText = undefined;
    user.lastLoeError = undefined;
    await writeStateToDisk(state);
  });

  const groups = state.users[chatId]?.groups ?? [];
  await ctx.reply(groups.length ? `Видалено ✅\nТепер групи: ${groups.join(', ')}` : 'Видалено ✅\nГрупи порожні. Використайте /add_group');
  await checkLikeCheckCommand(ctx);
}

bot.command('remove_group', removeGroupCommand);
// Backward-compatible alias
bot.command('groups_remove', removeGroupCommand);

bot.command('check', async (ctx) => {
  await checkLikeCheckCommand(ctx);
});

bot.on('text', async (ctx) => {
  
  // Lightweight fallback for users who just type the 3 parameters on separate lines
  const msg = (ctx.message.text ?? '').trim();
  if (!msg) return;
  if (msg.startsWith('/')) return;

  const chatId = String(ctx.chat.id);
  const user = state.users[chatId];
  const pending = user?.pendingStep;

  if (pending) {
    if (pending === 'groups') {
      const groups = parseGroupsFromUserInput(msg);
      if (groups.length === 0) {
        await ctx.reply(['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: 1.1, 3.2'].join('\n'));
        await promptForNextStep(ctx, 'groups');
        return;
      }

      await runStateOp(async () => {
        const u = await ensureUser(chatId);
        u.groups = groups;
        u.pendingStep = undefined;
        u.watching = true; // enable by default once groups are set
        u.lastLoeWatchedText = undefined; // reset snapshot on change
        u.lastLoeError = undefined;
        await writeStateToDisk(state);
      });

      await ctx.reply(
        [
          'Збережено ✅',
          `Групи: ${groups.join(', ')}`,
          '',
          'Сповіщення: УВІМК.',
        ].join('\n'),
      );

      // Baseline + immediate forced check to show current info
      await runStateOp(async () => {
        const u = await ensureUser(chatId);
        await checkOneChat(chatId, u, true);
      });

      return;
    }

    if (pending === 'groups_add') {
      const toAdd = parseGroupsFromUserInput(msg);
      if (toAdd.length === 0) {
        await ctx.reply(['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: 1.1, 3.2'].join('\n'));
        await promptForNextStep(ctx, 'groups_add');
        return;
      }

      await runStateOp(async () => {
        const u = await ensureUser(chatId);
        const current = u.groups ?? [];
        u.groups = [...current, ...toAdd].filter((g, idx, arr) => arr.indexOf(g) === idx);
        u.pendingStep = undefined;
        u.lastLoeWatchedText = undefined;
        u.lastLoeError = undefined;
        await writeStateToDisk(state);
      });

      const groups = state.users[chatId]?.groups ?? [];
      await ctx.reply(`Додано ✅\nТепер групи: ${groups.join(', ')}`);
      await checkLikeCheckCommand(ctx);
      return;
    }

    if (pending === 'groups_remove') {
      const toRemove = parseGroupsFromUserInput(msg);
      if (toRemove.length === 0) {
        await ctx.reply(['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: 1.1, 3.2'].join('\n'));
        await promptForNextStep(ctx, 'groups_remove');
        return;
      }

      await runStateOp(async () => {
        const u = await ensureUser(chatId);
        const current = u.groups ?? [];
        u.groups = current.filter((g) => !toRemove.includes(g));
        u.pendingStep = undefined;
        u.lastLoeWatchedText = undefined;
        u.lastLoeError = undefined;
        await writeStateToDisk(state);
      });

      const groups = state.users[chatId]?.groups ?? [];
      await ctx.reply(groups.length ? `Видалено ✅\nТепер групи: ${groups.join(', ')}` : 'Видалено ✅\nГрупи порожні. Використайте /add_group');
      await checkLikeCheckCommand(ctx);
      return;
    }
  }
});

async function main() {
  state = await readStateFromDisk();

  // Ensure shape
  if (!state.users) state.users = {};

  // Make commands show up in Telegram UI ("/" menu)
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Почати роботу' },
      { command: 'groups_list', description: 'Показати вибрані групи' },
      { command: 'add_group', description: 'Додати групи' },
      { command: 'remove_group', description: 'Видалити групи' },
      { command: 'check', description: 'Перевірити зараз' },
    ]);
  } catch {
    // ignore: bot can still run even if Telegram command registration fails
  }

  // const message = `Робочий тиждень добігає кінця, а вечір п’ятниці вже тут 🌙\nСаме час перепочити, перезавантажитися й підготуватися до нового дня 🌞\nНехай у кожного буде затишний вечір, тиха ніч, багато світла та мирні вихідні 🕊️✨\nЯкщо виникнуть питання чи потрібна буде підтримка — я завжди на зв’язку 🤝\nІз задоволенням допоможу 💪\nВаш Енерго-Бот 🤖`;
  // setTimeout(async () => {
  //   const users = Object.keys(state.users);
  //   for (const userId of users) {
  //     await bot.telegram.sendMessage(userId, message);
  //   }
  // }, 2000);

  // Initial check shortly after boot, then keep scheduling the next run with a randomized delay.
  const scheduleNext = () => {
    const delayMs = nextCheckDelayMs();
    console.log(`Next scheduled check in ${delayMs}ms (${formatInterval(delayMs)})`);
    setTimeout(() => {
      console.log('Checking all watching chats...', new Date().toISOString());
      runStateOp(async () => {
        await checkAllWatchingChats();
      })
        .catch(() => undefined)
        .finally(() => scheduleNext());
    }, delayMs);
  };

  setTimeout(() => {
    runStateOp(async () => {
      await checkAllWatchingChats();
    })
      .catch(() => undefined)
      .finally(() => scheduleNext());
  }, 2000);

  // If this bot was previously configured with a webhook, long-polling will fail.
  // Clearing webhook here makes long-polling startup more reliable across deploys.
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true } as any);
  } catch {
    // ignore
  }

  try {
    await bot.launch({ dropPendingUpdates: true });
  } catch (err: any) {
    const code = err?.response?.error_code;
    const desc = err?.response?.description ?? err?.description ?? err?.message;
    if (code === 409) {
      // eslint-disable-next-line no-console
      console.error(
        [
          'Telegram 409 conflict while starting long polling.',
          'This means another bot instance is already calling getUpdates for the same BOT_TOKEN.',
          'Stop the other instance (local dev / another Render service / another process) or switch to webhooks.',
          `Details: ${String(desc)}`,
        ].join(' '),
      );
    }
    throw err;
  }
  
  // eslint-disable-next-line no-console
  console.log(
    FIXED_CHECK_EVERY_MS !== undefined
      ? `Bot is running.. Scheduler interval: ${FIXED_CHECK_EVERY_MS}ms`
      : `Bot is running.. Scheduler interval: randomized ${CHECK_EVERY_MIN_MS}ms..${CHECK_EVERY_MAX_MS}ms`,
  );
}

main().then(() => {
  console.log('Bot is running..');
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => {
  try {
    bot.stop('SIGINT');
  } catch {
    // ignore (nodemon restarts can call stop before launch fully completes)
  }
});
process.once('SIGTERM', () => {
  try {
    bot.stop('SIGTERM');
  } catch {
    // ignore
  }
});

