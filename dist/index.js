"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", { value: true });
const telegraf_1 = require("telegraf");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const schedule_1 = require("./schedule");
const STATE_FILE_PATH = node_path_1.default.join(process.cwd(), 'label-state.json');
try {
    process.loadEnvFile(node_path_1.default.join(process.cwd(), '.env'));
}
catch (err) {
    if (err.code !== 'ENOENT')
        throw err;
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
const CHECK_EVERY_MIN_MS = Number((_a = process.env.CHECK_EVERY_MIN_MS) !== null && _a !== void 0 ? _a : DEFAULT_CHECK_EVERY_MIN_MS);
const CHECK_EVERY_MAX_MS = Number((_b = process.env.CHECK_EVERY_MAX_MS) !== null && _b !== void 0 ? _b : DEFAULT_CHECK_EVERY_MAX_MS);
if (!Number.isFinite(CHECK_EVERY_MIN_MS) || CHECK_EVERY_MIN_MS <= 0) {
    throw new Error('CHECK_EVERY_MIN_MS must be a positive number (milliseconds)');
}
if (!Number.isFinite(CHECK_EVERY_MAX_MS) || CHECK_EVERY_MAX_MS <= 0) {
    throw new Error('CHECK_EVERY_MAX_MS must be a positive number (milliseconds)');
}
if (CHECK_EVERY_MIN_MS > CHECK_EVERY_MAX_MS) {
    throw new Error('CHECK_EVERY_MIN_MS must be <= CHECK_EVERY_MAX_MS');
}
function randomIntInclusive(min, max) {
    const a = Math.ceil(min);
    const b = Math.floor(max);
    return Math.floor(Math.random() * (b - a + 1)) + a;
}
function nextCheckDelayMs() {
    if (FIXED_CHECK_EVERY_MS !== undefined)
        return FIXED_CHECK_EVERY_MS;
    return randomIntInclusive(CHECK_EVERY_MIN_MS, CHECK_EVERY_MAX_MS);
}
function formatInterval(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60)
        return `${sec} секунд`;
    const min = Math.round(sec / 60);
    return `${min} хвилин`;
}
function parseGroupsFromUserInput(raw) {
    // Extract group-like tokens from free-form input.
    // Supports separators: comma or dot inside group id (1,1 or 1.1)
    // Supports multiple groups in one message using ";" (or any other text).
    const out = [];
    const re = /(\d+)[.,](\d+)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const g = (0, schedule_1.normalizeGroupId)(`${m[1]}.${m[2]}`);
        if (g && !out.includes(g))
            out.push(g);
    }
    // Validate against known possible groups
    return out.filter((g) => schedule_1.POSSIBLE_GROUPS.includes(g));
}
function formatPossibleGroups() {
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
function readStateFile() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            return yield promises_1.default.readFile(STATE_FILE_PATH, 'utf8');
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT')
                return undefined;
            throw new Error(`Unable to read bot state at ${STATE_FILE_PATH} (${code !== null && code !== void 0 ? code : 'unknown error'})`);
        }
    });
}
let lastSavedState;
function readStateFromDisk() {
    return __awaiter(this, void 0, void 0, function* () {
        const raw = yield readStateFile();
        if (raw === undefined)
            return { users: {} };
        let parsed;
        try {
            parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        }
        catch (_a) {
            throw new Error(`Invalid JSON in bot state at ${STATE_FILE_PATH}`);
        }
        if (!parsed || typeof parsed !== 'object' || !('users' in parsed)
            || !parsed.users || typeof parsed.users !== 'object' || Array.isArray(parsed.users)) {
            throw new Error(`Expected a users object in bot state at ${STATE_FILE_PATH}`);
        }
        const loaded = normalizeStateShape(parsed);
        lastSavedState = raw;
        return loaded;
    });
}
function normalizeStateShape(input) {
    const misplacedUsers = Object.fromEntries(Object.entries(input).filter(([chatId, user]) => /^-?\d+$/.test(chatId) && user && typeof user === 'object' && 'watching' in user && typeof user.watching === 'boolean'));
    // Preserve chat records accidentally saved alongside the users object.
    const rawUsers = Object.assign(Object.assign({}, misplacedUsers), input.users);
    const users = {};
    for (const [chatId, raw] of Object.entries(rawUsers)) {
        const u = raw && typeof raw === 'object' ? raw : {};
        const pending = u.pendingStep === 'groups' || u.pendingStep === 'groups_add' || u.pendingStep === 'groups_remove'
            ? u.pendingStep
            : undefined;
        users[chatId] = {
            groups: Array.isArray(u.groups) ? u.groups.filter((x) => typeof x === 'string') : undefined,
            pendingStep: pending,
            watching: Boolean(u.watching),
            lastLoeCheckedAt: typeof u.lastLoeCheckedAt === 'string' ? u.lastLoeCheckedAt : undefined,
            lastLoeNotifiedAt: typeof u.lastLoeNotifiedAt === 'string' ? u.lastLoeNotifiedAt : undefined,
            lastLoeWatchedText: typeof u.lastLoeWatchedText === 'string' ? u.lastLoeWatchedText : undefined,
            lastLoeScheduleDate: typeof u.lastLoeScheduleDate === 'string' ? u.lastLoeScheduleDate : undefined,
            lastLoeError: typeof u.lastLoeError === 'string' ? u.lastLoeError : undefined,
            lastLoeTomorrowCheckedAt: typeof u.lastLoeTomorrowCheckedAt === 'string' ? u.lastLoeTomorrowCheckedAt : undefined,
            lastLoeTomorrowNotifiedAt: typeof u.lastLoeTomorrowNotifiedAt === 'string' ? u.lastLoeTomorrowNotifiedAt : undefined,
            lastLoeTomorrowWatchedText: typeof u.lastLoeTomorrowWatchedText === 'string' ? u.lastLoeTomorrowWatchedText : undefined,
            lastLoeTomorrowScheduleDate: typeof u.lastLoeTomorrowScheduleDate === 'string' ? u.lastLoeTomorrowScheduleDate : undefined,
            lastLoeTomorrowStatus: u.lastLoeTomorrowStatus === 'missing' || u.lastLoeTomorrowStatus === 'present'
                ? u.lastLoeTomorrowStatus
                : undefined,
            lastLoeTomorrowError: typeof u.lastLoeTomorrowError === 'string' ? u.lastLoeTomorrowError : undefined,
        };
    }
    return { users };
}
function writeStateToDisk(state) {
    return __awaiter(this, void 0, void 0, function* () {
        const content = JSON.stringify(normalizeStateShape(state), null, 2);
        const tmp = `${STATE_FILE_PATH}.${process.pid}.tmp`;
        try {
            yield promises_1.default.writeFile(tmp, content, 'utf8');
            if ((yield readStateFile()) !== lastSavedState) {
                throw new Error(`Bot state changed on disk at ${STATE_FILE_PATH}. Restart the bot to reload it.`);
            }
            yield promises_1.default.rename(tmp, STATE_FILE_PATH);
            lastSavedState = content;
        }
        finally {
            yield promises_1.default.rm(tmp, { force: true });
        }
    });
}
const token = (_c = process.env.BOT_TOKEN) === null || _c === void 0 ? void 0 : _c.trim();
if (!token) {
    throw new Error('Вкажіть BOT_TOKEN у файлі .env поруч із package.json або в змінних середовища.');
}
const bot = new telegraf_1.Telegraf(token);
let state = { users: {} };
let stateOp = Promise.resolve();
function runStateOp(fn) {
    const next = stateOp.then(fn, fn);
    stateOp = next.then(() => undefined, () => undefined);
    return next;
}
function ensureUser(chatId) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!state.users[chatId])
            state.users[chatId] = { watching: false };
        return state.users[chatId];
    });
}
const scheduleFeed = (0, schedule_1.createScheduleFeed)();
let lastAppliedSnapshot;
const NO_GROUPS = 'Не задано групи. Використайте /add_group, наприклад: /add_group 1.1, 3.2';
function selectedSchedule(day, groups) {
    if (!day || !groups.some((group) => typeof day.groups[group] === 'string'))
        return undefined;
    return Object.assign(Object.assign({}, day), { groups: Object.fromEntries(groups.map((group) => { var _a; return [group, (_a = day.groups[group]) !== null && _a !== void 0 ? _a : '(Не знайдено в графіку)']; })) });
}
function scheduleLines(day) {
    return Object.entries(day.groups).map(([group, text]) => `Група ${group}. ${text}`);
}
function saveTodayBaseline(user) {
    var _a, _b;
    const day = selectedSchedule((_a = scheduleFeed.read().snapshot) === null || _a === void 0 ? void 0 : _a.today, (_b = user.groups) !== null && _b !== void 0 ? _b : []);
    const current = (day === null || day === void 0 ? void 0 : day.date) === (0, schedule_1.kyivDate)(Date.now()) ? day : undefined;
    user.lastLoeWatchedText = current ? [...current.headers, ...scheduleLines(current)].join('\n') : undefined;
    user.lastLoeScheduleDate = current === null || current === void 0 ? void 0 : current.date;
}
function scheduleMessage(title, day) {
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
function scheduleChanged(day, previousText, previousDate) {
    var _a, _b;
    const previous = (0, schedule_1.parseScheduleText)(previousText);
    const date = (_b = (0, schedule_1.dateFromHeading)((_a = previous.headers[0]) !== null && _a !== void 0 ? _a : '')) !== null && _b !== void 0 ? _b : previousDate;
    return (date !== undefined && day.date !== date)
        || Object.entries(day.groups).some(([group, text]) => previous.groups[group] !== text);
}
function previousScheduleDate(date, checkedAt, daysAhead = 0) {
    const checkedTime = checkedAt ? Date.parse(checkedAt) : NaN;
    return date !== null && date !== void 0 ? date : (Number.isFinite(checkedTime) ? (0, schedule_1.kyivDate)(checkedTime, daysAhead) : undefined);
}
function notifyChat(chatId, user, groups, snapshot) {
    return __awaiter(this, void 0, void 0, function* () {
        const { fetchedAt } = snapshot;
        const checkedAt = new Date(fetchedAt).toISOString();
        const today = selectedSchedule(snapshot.today, groups);
        const tomorrow = selectedSchedule(snapshot.tomorrow, groups);
        const tomorrowDate = (0, schedule_1.kyivDate)(fetchedAt, 1);
        if ((today === null || today === void 0 ? void 0 : today.date) === (0, schedule_1.kyivDate)(fetchedAt)) {
            const previous = user.lastLoeWatchedText;
            const previousDate = previousScheduleDate(user.lastLoeScheduleDate, user.lastLoeCheckedAt);
            if (previous && scheduleChanged(today, previous, previousDate)) {
                const title = previousDate && today.date !== previousDate
                    ? '🔥 Графік відключень на сьогодні!'
                    : '🔥 Графік відключень на сьогодні змінився!';
                yield bot.telegram.sendMessage(chatId, scheduleMessage(title, today));
                user.lastLoeNotifiedAt = checkedAt;
            }
            user.lastLoeWatchedText = [...today.headers, ...scheduleLines(today)].join('\n');
            user.lastLoeScheduleDate = today.date;
            user.lastLoeCheckedAt = checkedAt;
            user.lastLoeError = undefined;
        }
        if ((tomorrow === null || tomorrow === void 0 ? void 0 : tomorrow.date) === tomorrowDate) {
            const previous = user.lastLoeTomorrowWatchedText;
            const previousDate = previousScheduleDate(user.lastLoeTomorrowScheduleDate, user.lastLoeTomorrowCheckedAt, 1);
            const appeared = !previous || (previousDate !== undefined && tomorrow.date !== previousDate);
            if (appeared || scheduleChanged(tomorrow, previous, previousDate)) {
                const title = appeared ? '🗓️ Зʼявився графік відключень на завтра!' : '🗓️ Графік відключень на завтра змінився!';
                yield bot.telegram.sendMessage(chatId, scheduleMessage(title, tomorrow));
                user.lastLoeTomorrowNotifiedAt = checkedAt;
            }
            user.lastLoeTomorrowWatchedText = [...tomorrow.headers, ...scheduleLines(tomorrow)].join('\n');
            user.lastLoeTomorrowScheduleDate = tomorrow.date;
            user.lastLoeTomorrowStatus = 'present';
        }
        else if (!snapshot.tomorrow || snapshot.tomorrow.date === tomorrowDate) {
            user.lastLoeTomorrowStatus = 'missing';
            // Keep the last published version so a temporary disappearance does not cause another alert.
        }
        user.lastLoeTomorrowCheckedAt = checkedAt;
        user.lastLoeTomorrowError = undefined;
    });
}
function refreshSchedules(trigger) {
    return __awaiter(this, void 0, void 0, function* () {
        const result = yield scheduleFeed.refresh(trigger);
        const snapshot = result.snapshot;
        if (!snapshot || result.error || snapshot === lastAppliedSnapshot)
            return result;
        yield runStateOp(() => __awaiter(this, void 0, void 0, function* () {
            var _a;
            if (snapshot === lastAppliedSnapshot)
                return;
            let deliveryFailed = false;
            for (const [chatId, user] of Object.entries(state.users)) {
                if (!user.watching || !((_a = user.groups) === null || _a === void 0 ? void 0 : _a.length))
                    continue;
                try {
                    yield notifyChat(chatId, user, user.groups, snapshot);
                }
                catch (error) {
                    deliveryFailed = true;
                    console.error('Schedule notification failed:', error instanceof Error ? error.message : String(error));
                }
            }
            yield writeStateToDisk(state);
            if (!deliveryFailed)
                lastAppliedSnapshot = snapshot;
        }));
        return result;
    });
}
function showSchedule(ctx_1) {
    return __awaiter(this, arguments, void 0, function* (ctx, result = scheduleFeed.read(), nextFetchAt) {
        var _a;
        const groups = (_a = state.users[String(ctx.chat.id)]) === null || _a === void 0 ? void 0 : _a.groups;
        if (!(groups === null || groups === void 0 ? void 0 : groups.length)) {
            yield ctx.reply(NO_GROUPS);
            return;
        }
        const snapshot = result.snapshot;
        const status = [
            snapshot ? `Графік отримано: ${schedule_1.kyivTimeFormatter.format(snapshot.fetchedAt)} (за Києвом).` : '',
            result.error ? 'Не вдалося оновити графік.' : '',
            nextFetchAt ? `Наступний запит до API можливий з ${schedule_1.kyivTimeFormatter.format(nextFetchAt)} (за Києвом).` : '',
        ].filter(Boolean);
        const today = selectedSchedule(snapshot === null || snapshot === void 0 ? void 0 : snapshot.today, groups);
        const tomorrow = selectedSchedule(snapshot === null || snapshot === void 0 ? void 0 : snapshot.tomorrow, groups);
        if (!today && !tomorrow) {
            status.push('Для вибраних груп графік наразі недоступний.');
            if (!nextFetchAt)
                status.push('Скористайтеся /check, щоб перевірити оновлення.');
        }
        yield ctx.reply(status.join('\n'));
        if (today)
            yield ctx.reply(scheduleMessage('🔥 Графік відключень', today));
        if (tomorrow)
            yield ctx.reply(scheduleMessage('🗓️ Графік відключень', tomorrow));
    });
}
function checkCommand(ctx) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (!((_b = (_a = state.users[String(ctx.chat.id)]) === null || _a === void 0 ? void 0 : _a.groups) === null || _b === void 0 ? void 0 : _b.length)) {
            yield ctx.reply(NO_GROUPS);
            return;
        }
        const result = yield refreshSchedules('manual');
        yield showSchedule(ctx, result, scheduleFeed.nextFetchAt());
    });
}
function checkAllWatchingChats() {
    return __awaiter(this, void 0, void 0, function* () {
        const chatCount = Object.values(state.users).filter((user) => { var _a; return user.watching && ((_a = user.groups) === null || _a === void 0 ? void 0 : _a.length); }).length;
        if (!chatCount)
            return;
        console.info(`[LOE] Scheduled check for ${chatCount} subscribed chats`);
        yield refreshSchedules('scheduled');
    });
}
function promptForNextStep(ctx, step) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (step === 'groups') {
            yield ctx.reply([
                'Які групи відключень вас цікавлять?',
                'Можна вказати одну або декілька груп в одному повідомленні (через ;).',
                'Формат групи: 1.1 або 1,1',
                '',
                formatPossibleGroups(),
                '',
                'Приклад:',
                '1,1; 3.2; 4,2',
            ].join('\n'));
            return;
        }
        if (step === 'groups_add') {
            yield ctx.reply(['Які групи додати?', 'Формат: 1.1 або 1,1', '', formatPossibleGroups(), '', 'Приклад: 1,1; 3.2'].join('\n'));
            return;
        }
        if (step === 'groups_remove') {
            const currentGroups = (_b = (_a = state.users[String(ctx.chat.id)]) === null || _a === void 0 ? void 0 : _a.groups) !== null && _b !== void 0 ? _b : [];
            yield ctx.reply(['Які групи видалити?', '', 'Наразі вибрані групи: ' + currentGroups.join(', '), '', 'Приклад: 1,1; 3.2'].join('\n'));
            return;
        }
    });
}
bot.start((ctx) => __awaiter(void 0, void 0, void 0, function* () {
    const chatId = String(ctx.chat.id);
    yield runStateOp(() => __awaiter(void 0, void 0, void 0, function* () {
        const user = yield ensureUser(chatId);
        user.pendingStep = 'groups';
        yield writeStateToDisk(state);
    }));
    yield ctx.reply('Привіт!\nЯ чат-бот який вміє відстежувати графік погодинних відключень для вибраних груп та сповіщати, коли він зміниться.\nДодай групи відключень електроенергії та я буду сповіщати тебе, коли вони зміняться.');
    yield promptForNextStep(ctx, 'groups');
}));
bot.command('groups_list', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const chatId = String(ctx.chat.id);
    const user = state.users[chatId];
    const groups = (_a = user === null || user === void 0 ? void 0 : user.groups) !== null && _a !== void 0 ? _a : [];
    if (groups.length === 0) {
        yield ctx.reply('Групи не задані. Використайте /add_group, наприклад: /add_group 1.1, 3.2');
        return;
    }
    yield ctx.reply(`Ваші групи: ${groups.join(', ')}`);
}));
function addGroupCommand(ctx) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const chatId = String(ctx.chat.id);
        const tail = ((_b = (_a = ctx.message) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : '')
            .replace(/^\/(add_group|groups_add)(@\w+)?/i, '')
            .trim();
        if (!tail) {
            yield runStateOp(() => __awaiter(this, void 0, void 0, function* () {
                const user = yield ensureUser(chatId);
                user.pendingStep = 'groups_add';
                yield writeStateToDisk(state);
            }));
            yield promptForNextStep(ctx, 'groups_add');
            return;
        }
        const toAdd = parseGroupsFromUserInput(tail);
        if (toAdd.length === 0) {
            yield ctx.reply(['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: /add_group 1,1; 3.2'].join('\n'));
            return;
        }
        yield runStateOp(() => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const user = yield ensureUser(chatId);
            const current = (_a = user.groups) !== null && _a !== void 0 ? _a : [];
            user.groups = [...current, ...toAdd].filter((g, idx, arr) => arr.indexOf(g) === idx);
            user.pendingStep = undefined;
            saveTodayBaseline(user);
            user.lastLoeError = undefined;
            yield writeStateToDisk(state);
        }));
        const groups = (_d = (_c = state.users[chatId]) === null || _c === void 0 ? void 0 : _c.groups) !== null && _d !== void 0 ? _d : [];
        yield ctx.reply(`Додано ✅\nВи відстежуєте такі групи відключень електроенергії: ${groups.join(', ')}`);
        yield showSchedule(ctx);
    });
}
bot.command('add_group', addGroupCommand);
// Backward-compatible alias
bot.command('groups_add', addGroupCommand);
function removeGroupCommand(ctx) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const chatId = String(ctx.chat.id);
        const tail = ((_b = (_a = ctx.message) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : '')
            .replace(/^\/(remove_group|groups_remove)(@\w+)?/i, '')
            .trim();
        if (!tail) {
            yield runStateOp(() => __awaiter(this, void 0, void 0, function* () {
                const user = yield ensureUser(chatId);
                user.pendingStep = 'groups_remove';
                yield writeStateToDisk(state);
            }));
            yield promptForNextStep(ctx, 'groups_remove');
            return;
        }
        const toRemove = parseGroupsFromUserInput(tail);
        if (toRemove.length === 0) {
            yield ctx.reply(['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: /remove_group 1,1; 3.2'].join('\n'));
            return;
        }
        yield runStateOp(() => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const user = yield ensureUser(chatId);
            const current = (_a = user.groups) !== null && _a !== void 0 ? _a : [];
            user.groups = current.filter((g) => !toRemove.includes(g));
            user.pendingStep = undefined;
            saveTodayBaseline(user);
            user.lastLoeError = undefined;
            yield writeStateToDisk(state);
        }));
        const groups = (_d = (_c = state.users[chatId]) === null || _c === void 0 ? void 0 : _c.groups) !== null && _d !== void 0 ? _d : [];
        yield ctx.reply(groups.length ? `Видалено ✅\nТепер групи: ${groups.join(', ')}` : 'Видалено ✅\nГрупи порожні. Використайте /add_group');
        yield showSchedule(ctx);
    });
}
bot.command('remove_group', removeGroupCommand);
// Backward-compatible alias
bot.command('groups_remove', removeGroupCommand);
bot.command('check', checkCommand);
bot.command('schedule', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    yield showSchedule(ctx);
}));
bot.on('text', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e;
    // Lightweight fallback for users who just type the 3 parameters on separate lines
    const msg = ((_a = ctx.message.text) !== null && _a !== void 0 ? _a : '').trim();
    if (!msg)
        return;
    if (msg.startsWith('/'))
        return;
    const chatId = String(ctx.chat.id);
    const user = state.users[chatId];
    const pending = user === null || user === void 0 ? void 0 : user.pendingStep;
    if (pending) {
        if (pending === 'groups') {
            const groups = parseGroupsFromUserInput(msg);
            if (groups.length === 0) {
                yield ctx.reply(['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: 1.1, 3.2'].join('\n'));
                yield promptForNextStep(ctx, 'groups');
                return;
            }
            yield runStateOp(() => __awaiter(void 0, void 0, void 0, function* () {
                const u = yield ensureUser(chatId);
                u.groups = groups;
                u.pendingStep = undefined;
                u.watching = true; // enable by default once groups are set
                saveTodayBaseline(u);
                u.lastLoeError = undefined;
                yield writeStateToDisk(state);
            }));
            yield ctx.reply([
                'Збережено ✅',
                `Групи: ${groups.join(', ')}`,
                '',
                'Сповіщення: УВІМК.',
            ].join('\n'));
            yield showSchedule(ctx);
            return;
        }
        if (pending === 'groups_add') {
            const toAdd = parseGroupsFromUserInput(msg);
            if (toAdd.length === 0) {
                yield ctx.reply(['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: 1.1, 3.2'].join('\n'));
                yield promptForNextStep(ctx, 'groups_add');
                return;
            }
            yield runStateOp(() => __awaiter(void 0, void 0, void 0, function* () {
                var _a;
                const u = yield ensureUser(chatId);
                const current = (_a = u.groups) !== null && _a !== void 0 ? _a : [];
                u.groups = [...current, ...toAdd].filter((g, idx, arr) => arr.indexOf(g) === idx);
                u.pendingStep = undefined;
                saveTodayBaseline(u);
                u.lastLoeError = undefined;
                yield writeStateToDisk(state);
            }));
            const groups = (_c = (_b = state.users[chatId]) === null || _b === void 0 ? void 0 : _b.groups) !== null && _c !== void 0 ? _c : [];
            yield ctx.reply(`Додано ✅\nТепер групи: ${groups.join(', ')}`);
            yield showSchedule(ctx);
            return;
        }
        if (pending === 'groups_remove') {
            const toRemove = parseGroupsFromUserInput(msg);
            if (toRemove.length === 0) {
                yield ctx.reply(['Не схоже на список груп.', '', formatPossibleGroups(), '', 'Приклад: 1.1, 3.2'].join('\n'));
                yield promptForNextStep(ctx, 'groups_remove');
                return;
            }
            yield runStateOp(() => __awaiter(void 0, void 0, void 0, function* () {
                var _a;
                const u = yield ensureUser(chatId);
                const current = (_a = u.groups) !== null && _a !== void 0 ? _a : [];
                u.groups = current.filter((g) => !toRemove.includes(g));
                u.pendingStep = undefined;
                saveTodayBaseline(u);
                u.lastLoeError = undefined;
                yield writeStateToDisk(state);
            }));
            const groups = (_e = (_d = state.users[chatId]) === null || _d === void 0 ? void 0 : _d.groups) !== null && _e !== void 0 ? _e : [];
            yield ctx.reply(groups.length ? `Видалено ✅\nТепер групи: ${groups.join(', ')}` : 'Видалено ✅\nГрупи порожні. Використайте /add_group');
            yield showSchedule(ctx);
            return;
        }
    }
}));
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        state = yield readStateFromDisk();
        console.info(`[State] Loaded ${Object.keys(state.users).length} chat records from ${STATE_FILE_PATH}`);
        // Make commands show up in Telegram UI ("/" menu)
        try {
            yield bot.telegram.setMyCommands([
                { command: 'start', description: 'Почати роботу' },
                { command: 'groups_list', description: 'Показати вибрані групи' },
                { command: 'add_group', description: 'Додати групи' },
                { command: 'remove_group', description: 'Видалити групи' },
                { command: 'schedule', description: 'Показати збережений графік' },
                { command: 'check', description: 'Запросити оновлення графіка' },
            ]);
        }
        catch (_e) {
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
            yield bot.telegram.deleteWebhook({ drop_pending_updates: true });
        }
        catch (_f) {
            // ignore
        }
        try {
            yield bot.launch({ dropPendingUpdates: true });
        }
        catch (err) {
            const code = (_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.error_code;
            const desc = (_d = (_c = (_b = err === null || err === void 0 ? void 0 : err.response) === null || _b === void 0 ? void 0 : _b.description) !== null && _c !== void 0 ? _c : err === null || err === void 0 ? void 0 : err.description) !== null && _d !== void 0 ? _d : err === null || err === void 0 ? void 0 : err.message;
            if (code === 409) {
                // eslint-disable-next-line no-console
                console.error([
                    'Telegram 409 conflict while starting long polling.',
                    'This means another bot instance is already calling getUpdates for the same BOT_TOKEN.',
                    'Stop the other instance (local dev / another Render service / another process) or switch to webhooks.',
                    `Details: ${String(desc)}`,
                ].join(' '));
            }
            throw err;
        }
        // eslint-disable-next-line no-console
        console.log(FIXED_CHECK_EVERY_MS !== undefined
            ? `Bot is running.. Scheduler interval: ${FIXED_CHECK_EVERY_MS}ms`
            : `Bot is running.. Scheduler interval: randomized ${CHECK_EVERY_MIN_MS}ms..${CHECK_EVERY_MAX_MS}ms`);
    });
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
    }
    catch (_a) {
        // ignore (nodemon restarts can call stop before launch fully completes)
    }
});
process.once('SIGTERM', () => {
    try {
        bot.stop('SIGTERM');
    }
    catch (_a) {
        // ignore
    }
});
