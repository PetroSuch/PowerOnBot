import { Telegraf, type Context } from 'telegraf';
import { POSSIBLE_GROUPS, type ManagedSubscription, type ScheduleDay, type ScheduleResponse, type ScheduleSnapshot } from '@poweron/shared';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createScheduleFeed,
  dateFromHeading,
  kyivDate,
  kyivTimeFormatter,
  normalizeGroupId,
  parseScheduleText,
} from './schedule';
import { startPwaServer } from './pwa';
import { openTelegramState } from './telegram-state';
import { openConfiguredAccounts, type Accounts } from './accounts';

type IsoDateString = string;

type UserState = {
  // New LOE "group" tracking
  groups?: string[]; // e.g. ["1.1", "3.2"]
  pendingStep?: 'groups' | 'groups_add' | 'groups_remove';

  watching: boolean;

  // LOE-based tracking snapshot (for watched groups)
  lastLoeCheckedAt?: IsoDateString;
  lastLoeNotifiedAt?: IsoDateString;
  lastLoeWatchedText?: string;
  lastLoeScheduleDate?: string;
  lastLoeError?: string;

  // LOE "Tomorrow" tracking snapshot (for watched groups)
  lastLoeTomorrowCheckedAt?: IsoDateString;
  lastLoeTomorrowNotifiedAt?: IsoDateString;
  lastLoeTomorrowWatchedText?: string;
  lastLoeTomorrowScheduleDate?: string;
  lastLoeTomorrowStatus?: 'missing' | 'present';
  lastLoeTomorrowError?: string;
};

type BotState = {
  users: Record<string, UserState>;
};

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STATE_FILE_PATH = path.join(REPO_ROOT, 'label-state.json');
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(path.join(REPO_ROOT, file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
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
  return out.filter((g) => POSSIBLE_GROUPS.includes(g));
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

async function readStateFile(): Promise<string | undefined> {
  try {
    return await fs.readFile(STATE_FILE_PATH, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new Error(`Unable to read bot state at ${STATE_FILE_PATH} (${code ?? 'unknown error'})`);
  }
}

let lastSavedState: string | undefined;

async function readStateFromDisk(): Promise<BotState> {
  const raw = await readStateFile();
  if (raw === undefined) return { users: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`Invalid JSON in bot state at ${STATE_FILE_PATH}`);
  }
  if (!parsed || typeof parsed !== 'object' || !('users' in parsed)
    || !parsed.users || typeof parsed.users !== 'object' || Array.isArray(parsed.users)) {
    throw new Error(`Expected a users object in bot state at ${STATE_FILE_PATH}`);
  }

  const loaded = normalizeStateShape(parsed);
  lastSavedState = raw;
  return loaded;
}

function normalizeStateShape(input: any): BotState {
  const misplacedUsers = Object.fromEntries(
    Object.entries(input).filter(([chatId, user]) =>
      /^-?\d+$/.test(chatId) && user && typeof user === 'object' && 'watching' in user && typeof user.watching === 'boolean',
    ),
  );
  // Preserve chat records accidentally saved alongside the users object.
  const rawUsers = { ...misplacedUsers, ...input.users };
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
      lastLoeScheduleDate: typeof u.lastLoeScheduleDate === 'string' ? u.lastLoeScheduleDate : undefined,
      lastLoeError: typeof u.lastLoeError === 'string' ? u.lastLoeError : undefined,

      lastLoeTomorrowCheckedAt: typeof u.lastLoeTomorrowCheckedAt === 'string' ? u.lastLoeTomorrowCheckedAt : undefined,
      lastLoeTomorrowNotifiedAt:
        typeof u.lastLoeTomorrowNotifiedAt === 'string' ? u.lastLoeTomorrowNotifiedAt : undefined,
      lastLoeTomorrowWatchedText:
        typeof u.lastLoeTomorrowWatchedText === 'string' ? u.lastLoeTomorrowWatchedText : undefined,
      lastLoeTomorrowScheduleDate:
        typeof u.lastLoeTomorrowScheduleDate === 'string' ? u.lastLoeTomorrowScheduleDate : undefined,
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
  const content = JSON.stringify(normalizeStateShape(state), null, 2);
  const tmp = `${STATE_FILE_PATH}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    if (await readStateFile() !== lastSavedState) {
      throw new Error(`Bot state changed on disk at ${STATE_FILE_PATH}. Restart the bot to reload it.`);
    }
    await fs.rename(tmp, STATE_FILE_PATH);
    lastSavedState = content;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

let telegramStateStore: Awaited<ReturnType<typeof openTelegramState<BotState>>> | undefined;

async function saveState(state: BotState): Promise<void> {
  if (telegramStateStore) {
    await telegramStateStore.save(normalizeStateShape(state));
  } else {
    await writeStateToDisk(state);
  }
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

const scheduleFeed = createScheduleFeed();
let lastAppliedSnapshot: ScheduleSnapshot | undefined;
let pwaServer: Awaited<ReturnType<typeof startPwaServer>> | undefined;
let accounts: Accounts | undefined;

async function chatGroups(chatId: string): Promise<string[]> {
  return (await accounts?.linkedChat(chatId))?.groups ?? state.users[chatId]?.groups ?? [];
}

async function setChatGroups(chatId: string, user: UserState, groups: string[]) {
  const linked = await accounts?.linkedChat(chatId);
  if (accounts && linked) {
    await accounts.replaceGroups(linked.user_id, groups);
    user.groups = undefined;
  } else {
    user.groups = groups;
  }
  saveTodayBaseline(user, groups);
}
type ChatContext = Context & { chat: NonNullable<Context['chat']> };
const NO_GROUPS = 'Не задано групи. Використайте /add_group, наприклад: /add_group 1.1, 3.2';

function selectedSchedule(day: ScheduleDay | undefined, groups: string[]): ScheduleDay | undefined {
  if (!day || !groups.some((group) => typeof day.groups[group] === 'string')) return undefined;
  return {
    ...day,
    groups: Object.fromEntries(groups.map((group) => [group, day.groups[group] ?? '(Не знайдено в графіку)'])),
  };
}

function scheduleLines(day: ScheduleDay): string[] {
  return Object.entries(day.groups).map(([group, text]) => `Група ${group}. ${text}`);
}

function saveTodayBaseline(user: UserState, groups: string[]) {
  const day = selectedSchedule(scheduleFeed.read().snapshot?.today, groups);
  const current = day?.date === kyivDate(Date.now()) ? day : undefined;
  user.lastLoeWatchedText = current ? [...current.headers, ...scheduleLines(current)].join('\n') : undefined;
  user.lastLoeScheduleDate = current?.date;
}

function scheduleMessage(title: string, day: ScheduleDay): string {
  const lines = scheduleLines(day).map((line) => line
    .replace('Електроенергії немає', '\nЕлектроенергії немає:\n')
    .replace(/,\s*/g, '\n'));
  return [
    `${title} (${day.date.split('-').reverse().join('.')})`,
    ...day.headers,
    '',
    lines.join('\n\n'),
    day.imageUrl ? `\nГрафік відключень: ${day.imageUrl}` : '',
  ].join('\n').trim();
}

function scheduleChanged(day: ScheduleDay, previousText: string, previousDate?: string): boolean {
  const previous = parseScheduleText(previousText);
  const date = dateFromHeading(previous.headers[0] ?? '') ?? previousDate;
  return (date !== undefined && day.date !== date)
    || Object.entries(day.groups).some(([group, text]) => previous.groups[group] !== text);
}

function previousScheduleDate(date: string | undefined, checkedAt: string | undefined, daysAhead = 0): string | undefined {
  const checkedTime = checkedAt ? Date.parse(checkedAt) : NaN;
  return date ?? (Number.isFinite(checkedTime) ? kyivDate(checkedTime, daysAhead) : undefined);
}

async function notifyChat(chatId: string, user: UserState, groups: string[], snapshot: ScheduleSnapshot) {
  const { fetchedAt } = snapshot;
  const checkedAt = new Date(fetchedAt).toISOString();
  const today = selectedSchedule(snapshot.today, groups);
  const tomorrow = selectedSchedule(snapshot.tomorrow, groups);
  const tomorrowDate = kyivDate(fetchedAt, 1);

  if (today?.date === kyivDate(fetchedAt)) {
    const previous = user.lastLoeWatchedText;
    const previousDate = previousScheduleDate(user.lastLoeScheduleDate, user.lastLoeCheckedAt);
    if (previous && scheduleChanged(today, previous, previousDate)) {
      const title = previousDate && today.date !== previousDate
        ? '🔥 Графік відключень на сьогодні!'
        : '🔥 Графік відключень на сьогодні змінився!';
      await bot.telegram.sendMessage(chatId, scheduleMessage(title, today));
      user.lastLoeNotifiedAt = checkedAt;
    }
    user.lastLoeWatchedText = [...today.headers, ...scheduleLines(today)].join('\n');
    user.lastLoeScheduleDate = today.date;
    user.lastLoeCheckedAt = checkedAt;
    user.lastLoeError = undefined;
  }

  if (tomorrow?.date === tomorrowDate) {
    const previous = user.lastLoeTomorrowWatchedText;
    const previousDate = previousScheduleDate(user.lastLoeTomorrowScheduleDate, user.lastLoeTomorrowCheckedAt, 1);
    const appeared = !previous || (previousDate !== undefined && tomorrow.date !== previousDate);
    if (appeared || scheduleChanged(tomorrow, previous, previousDate)) {
      const title = appeared ? '🗓️ Зʼявився графік відключень на завтра!' : '🗓️ Графік відключень на завтра змінився!';
      await bot.telegram.sendMessage(chatId, scheduleMessage(title, tomorrow));
      user.lastLoeTomorrowNotifiedAt = checkedAt;
    }
    user.lastLoeTomorrowWatchedText = [...tomorrow.headers, ...scheduleLines(tomorrow)].join('\n');
    user.lastLoeTomorrowScheduleDate = tomorrow.date;
    user.lastLoeTomorrowStatus = 'present';
  } else if (!snapshot.tomorrow || snapshot.tomorrow.date === tomorrowDate) {
    user.lastLoeTomorrowStatus = 'missing';
    // Keep the last published version so a temporary disappearance does not cause another alert.
  }
  user.lastLoeTomorrowCheckedAt = checkedAt;
  user.lastLoeTomorrowError = undefined;
}

async function refreshSchedules(trigger: 'scheduled' | 'manual') {
  const result = await scheduleFeed.refresh(trigger);
  await applySchedule(result);
  return result;
}

async function applySchedule(result: ReturnType<typeof scheduleFeed.read>) {
  const snapshot = result.snapshot;
  if (!snapshot || result.error || snapshot === lastAppliedSnapshot) return;

  await runStateOp(async () => {
    if (snapshot === lastAppliedSnapshot) return;
    await telegramStateStore?.saveSchedule(snapshot, scheduleFeed.nextFetchAt());
    let deliveryFailed = false;
    let processed = false;
    const linkedGroups = new Map((await accounts?.linkedChats() ?? []).map((chat) => [chat.chat_id, chat.groups]));
    for (const [chatId, user] of Object.entries(state.users)) {
      const groups = linkedGroups.get(chatId) ?? user.groups;
      if (!user.watching || !groups?.length) continue;
      processed = true;
      try {
        await notifyChat(chatId, user, groups, snapshot);
      } catch (error) {
        deliveryFailed = true;
        console.error('Schedule notification failed:', error instanceof Error ? error.message : String(error));
      }
    }
    if (processed) await saveState(state);
    await pwaServer?.push?.publish(snapshot);
    if (!deliveryFailed) lastAppliedSnapshot = snapshot;
  });
}

async function listTelegramSubscriptions(): Promise<ManagedSubscription[]> {
  const linkedGroups = new Map((await accounts?.linkedChats() ?? []).map((chat) => [chat.chat_id, chat.groups]));
  return Object.entries(state.users).map(([id, chat]) => ({
    id, channel: 'telegram', groups: linkedGroups.get(id) ?? chat.groups ?? [], watching: chat.watching,
  }));
}

function updateTelegramSubscription(id: string, groups: string[], watching: boolean) {
  return runStateOp(async () => {
    const previous = state.users[id];
    if (!previous) return false;
    const updated = { ...previous, groups, watching, pendingStep: undefined };
    await setChatGroups(id, updated, groups);
    state.users[id] = updated;
    try {
      await saveState(state);
    } catch (error) {
      state.users[id] = previous;
      throw error;
    }
    return true;
  });
}

async function showSchedule(
  ctx: ChatContext,
  result: ReturnType<typeof scheduleFeed.read> = scheduleFeed.read(),
  nextFetchAt?: number,
): Promise<void> {
  const groups = await chatGroups(String(ctx.chat.id));
  if (!groups?.length) {
    await ctx.reply(NO_GROUPS);
    return;
  }

  const snapshot = result.snapshot;
  const status = [
    snapshot ? `Графік отримано: ${kyivTimeFormatter.format(snapshot.fetchedAt)} (за Києвом).` : '',
    result.error ? 'Не вдалося оновити графік.' : '',
    nextFetchAt ? `Наступний запит до API можливий з ${kyivTimeFormatter.format(nextFetchAt)} (за Києвом).` : '',
  ].filter(Boolean);
  const today = selectedSchedule(snapshot?.today, groups);
  const tomorrow = selectedSchedule(snapshot?.tomorrow, groups);
  if (!today && !tomorrow) {
    status.push('Для вибраних груп графік наразі недоступний.');
    if (!nextFetchAt) status.push('Скористайтеся /check, щоб перевірити оновлення.');
  }
  await ctx.reply(status.join('\n'));
  if (today) await ctx.reply(scheduleMessage('🔥 Графік відключень', today));
  if (tomorrow) await ctx.reply(scheduleMessage('🗓️ Графік відключень', tomorrow));
}

async function checkCommand(ctx: ChatContext): Promise<void> {
  if (!(await chatGroups(String(ctx.chat.id))).length) {
    await ctx.reply(NO_GROUPS);
    return;
  }

  const result = await refreshSchedules('manual');
  await showSchedule(ctx, result, scheduleFeed.nextFetchAt());
}

async function checkAllWatchingChats(): Promise<void> {
  const chatCount = Object.values(state.users).filter((user) => user.watching && (accounts || user.groups?.length)).length;
  if (!chatCount && !pwaServer) return;
  console.info(`[LOE] Scheduled check for ${chatCount} subscribed chats`);
  await refreshSchedules('scheduled');
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
    const currentGroups = await chatGroups(String(ctx.chat.id));
    await ctx.reply(
      ['Які групи видалити?', '', 'Наразі вибрані групи: ' + currentGroups.join(', '), '', 'Приклад: 1,1; 3.2'].join('\n'),
    );
    return;
  }
}

bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (ctx.startPayload?.startsWith('link_')) {
    const linked = accounts && ctx.chat.type === 'private' && ctx.from
      && await accounts.receiveLink(ctx.startPayload.slice(5), String(ctx.from.id), chatId);
    await ctx.reply(linked ? 'Поверніться у PowerOn і підтвердьте прив’язку Telegram.'
      : 'Посилання на прив’язку недійсне або вже використане.');
    return;
  }
  await runStateOp(async () => {
    const user = await ensureUser(chatId);
    user.pendingStep = 'groups';
    await saveState(state);
  });
  await ctx.reply('Привіт!\nЯ чат-бот який вміє відстежувати графік погодинних відключень для вибраних груп та сповіщати, коли він зміниться.\nДодай групи відключень електроенергії та я буду сповіщати тебе, коли вони зміняться.');
  await promptForNextStep(ctx, 'groups');
});

bot.command('groups_list', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const groups = await chatGroups(chatId);
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
      await saveState(state);
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
    await setChatGroups(chatId, user, [...new Set([...(await chatGroups(chatId)), ...toAdd])]);
    user.pendingStep = undefined;
    user.lastLoeError = undefined;
    await saveState(state);
  });

  const groups = await chatGroups(chatId);
  await ctx.reply(`Додано ✅\nВи відстежуєте такі групи відключень електроенергії: ${groups.join(', ')}`);
  await showSchedule(ctx);
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
      await saveState(state);
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
    await setChatGroups(chatId, user, (await chatGroups(chatId)).filter((g) => !toRemove.includes(g)));
    user.pendingStep = undefined;
    user.lastLoeError = undefined;
    await saveState(state);
  });

  const groups = await chatGroups(chatId);
  await ctx.reply(groups.length ? `Видалено ✅\nТепер групи: ${groups.join(', ')}` : 'Видалено ✅\nГрупи порожні. Використайте /add_group');
  await showSchedule(ctx);
}

bot.command('remove_group', removeGroupCommand);
// Backward-compatible alias
bot.command('groups_remove', removeGroupCommand);

bot.command('check', checkCommand);
bot.command('schedule', async (ctx) => {
  await showSchedule(ctx);
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
        await setChatGroups(chatId, u, groups);
        u.pendingStep = undefined;
        u.watching = true; // enable by default once groups are set
        u.lastLoeError = undefined;
        await saveState(state);
      });

      await ctx.reply(
        [
          'Збережено ✅',
          `Групи: ${groups.join(', ')}`,
          '',
          'Сповіщення: УВІМК.',
        ].join('\n'),
      );

      await showSchedule(ctx);

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
        await setChatGroups(chatId, u, [...new Set([...(await chatGroups(chatId)), ...toAdd])]);
        u.pendingStep = undefined;
        u.lastLoeError = undefined;
        await saveState(state);
      });

      const groups = await chatGroups(chatId);
      await ctx.reply(`Додано ✅\nТепер групи: ${groups.join(', ')}`);
      await showSchedule(ctx);
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
        await setChatGroups(chatId, u, (await chatGroups(chatId)).filter((g) => !toRemove.includes(g)));
        u.pendingStep = undefined;
        u.lastLoeError = undefined;
        await saveState(state);
      });

      const groups = await chatGroups(chatId);
      await ctx.reply(groups.length ? `Видалено ✅\nТепер групи: ${groups.join(', ')}` : 'Видалено ✅\nГрупи порожні. Використайте /add_group');
      await showSchedule(ctx);
      return;
    }
  }
});

async function main() {
  const importOnly = process.argv.includes('--import-telegram-state');
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const botId = token?.match(/^(\d+):/)?.[1];
    if (!botId) throw new Error('BOT_TOKEN must include the Telegram bot ID to select its PostgreSQL state');
    telegramStateStore = await openTelegramState({
      databaseUrl, directUrl: process.env.DATABASE_URL_UNPOOLED, botId,
    }, readStateFromDisk);
    state = normalizeStateShape(telegramStateStore.state);
    const action = telegramStateStore.initialized ? 'Initialized' : 'Loaded';
    console.info(`[State] ${action} ${Object.keys(state.users).length} chat records in PostgreSQL`);
  } else {
    if (importOnly) throw new Error('DATABASE_URL is required to import Telegram state');
    state = await readStateFromDisk();
    console.info(`[State] Loaded ${Object.keys(state.users).length} chat records from ${STATE_FILE_PATH}`);
  }
  if (importOnly) {
    await telegramStateStore?.close();
    return;
  }
  accounts = await openConfiguredAccounts();
  const adminFlag = process.argv.indexOf('--grant-admin');
  if (adminFlag !== -1) {
    const email = process.argv[adminFlag + 1];
    try {
      if (!email || !accounts || !await accounts.grantAdmin(email)) {
        throw new Error('A verified email-and-password account is required for administrator access');
      }
      console.info('[Accounts] Administrator role granted');
    } finally {
      await accounts?.close();
      await telegramStateStore?.close();
    }
    return;
  }
  const savedSchedule = await telegramStateStore?.readSchedule();
  if (savedSchedule) scheduleFeed.restore(savedSchedule.snapshot, savedSchedule.nextFetchAt);

  if (process.env.PWA_PORT) {
    const scheduleResponse = (result: ReturnType<typeof scheduleFeed.read>): ScheduleResponse => ({
      snapshot: result.snapshot,
      refreshFailed: Boolean(result.error),
      nextFetchAt: scheduleFeed.nextFetchAt(),
    });
    pwaServer = await startPwaServer(path.join(REPO_ROOT, 'apps', 'mobile', 'dist', 'browser'), {
      read: () => scheduleResponse(scheduleFeed.read()),
      refresh: async () => {
        const result = await scheduleFeed.refresh('manual');
        void applySchedule(result).catch(() => console.error('[PWA] Notification processing failed'));
        return scheduleResponse(result);
      },
    }, {
      webDirectory: path.join(REPO_ROOT, 'apps', 'web', 'dist', 'browser'),
      adminDirectory: path.join(REPO_ROOT, 'apps', 'admin', 'dist', 'browser'),
      accounts,
      telegram: telegramStateStore ? {
        list: listTelegramSubscriptions, update: updateTelegramSubscription,
        username: () => bot.botInfo?.username,
        legacyGroups: (id) => state.users[id]?.groups ?? [],
        onLinked: (id) => runStateOp(async () => {
          const user = state.users[id] ?? { watching: true };
          state.users[id] = { ...user, groups: undefined };
          await saveState(state);
        }),
      } : undefined,
    });
  }

  // Make commands show up in Telegram UI ("/" menu)
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Почати роботу' },
      { command: 'groups_list', description: 'Показати вибрані групи' },
      { command: 'add_group', description: 'Додати групи' },
      { command: 'remove_group', description: 'Видалити групи' },
      { command: 'schedule', description: 'Показати збережений графік' },
      { command: 'check', description: 'Запросити оновлення графіка' },
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
      checkAllWatchingChats()
        .catch((error) => console.error('Scheduled check failed:', error))
        .finally(() => scheduleNext());
    }, delayMs);
  };

  setTimeout(() => {
    checkAllWatchingChats()
      .catch((error) => console.error('Initial check failed:', error))
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

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});

process.once('SIGINT', () => {
  pwaServer?.close();
  void accounts?.close().catch(() => console.error('[Accounts] PostgreSQL shutdown failed'));
  void telegramStateStore?.close().catch(() => console.error('[State] PostgreSQL shutdown failed'));
  try {
    bot.stop('SIGINT');
  } catch {
    // ignore (nodemon restarts can call stop before launch fully completes)
  }
});
process.once('SIGTERM', () => {
  pwaServer?.close();
  void accounts?.close().catch(() => console.error('[Accounts] PostgreSQL shutdown failed'));
  void telegramStateStore?.close().catch(() => console.error('[State] PostgreSQL shutdown failed'));
  try {
    bot.stop('SIGTERM');
  } catch {
    // ignore
  }
});

