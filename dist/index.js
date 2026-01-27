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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
const telegraf_1 = require("telegraf");
const cheerio_1 = require("cheerio");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
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
];
const STATE_FILE_PATH = node_path_1.default.join(process.cwd(), 'label-state.json');
const DEFAULT_CHECK_EVERY_MS = 15 * 60 * 1000; // 15 minutes
const CHECK_EVERY_MS = Number((_a = process.env.CHECK_EVERY_MS) !== null && _a !== void 0 ? _a : DEFAULT_CHECK_EVERY_MS);
console.log('CHECK_EVERY_MS', CHECK_EVERY_MS);
if (!Number.isFinite(CHECK_EVERY_MS) || CHECK_EVERY_MS <= 0) {
    throw new Error('CHECK_EVERY_MS must be a positive number (milliseconds)');
}
function formatInterval(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60)
        return `${sec} секунд`;
    const min = Math.round(sec / 60);
    return `${min} хвилин`;
}
function normalizeHtml(html) {
    return html.replace(/\s+/g, ' ').trim();
}
function normalizeMultilineText(raw) {
    return raw
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n')
        .trim();
}
function absoluteLoeMediaUrl(pathname) {
    if (!pathname)
        return '';
    if (/^https?:\/\//i.test(pathname))
        return pathname;
    const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `https://api.loe.lviv.ua${p}`;
}
function extractGroupLinesOnly(text) {
    return normalizeMultilineText(text)
        .split('\n')
        .filter((l) => /^Група\s+\d+[.,]\d+\./i.test(l))
        .join('\n')
        .trim();
}
function textFromRawHtml(rawHtml) {
    if (!rawHtml)
        return '';
    const $ = (0, cheerio_1.load)(rawHtml);
    return normalizeMultilineText($.text());
}
function normalizeGroupId(raw) {
    const s = raw.trim();
    if (!s)
        return null;
    // Accept both dot and comma between numbers: 1.1 or 1,1
    const m = s.match(/^(\d+)[.,](\d+)$/);
    if (!m)
        return null;
    return `${Number(m[1])}.${Number(m[2])}`;
}
function parseGroupsFromUserInput(raw) {
    // Extract group-like tokens from free-form input.
    // Supports separators: comma or dot inside group id (1,1 or 1.1)
    // Supports multiple groups in one message using ";" (or any other text).
    const out = [];
    const re = /(\d+)[.,](\d+)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const g = normalizeGroupId(`${m[1]}.${m[2]}`);
        if (g && !out.includes(g))
            out.push(g);
    }
    // Validate against known possible groups
    return out.filter((g) => POSSIBLE_GROUPS.includes(g));
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
function parseGroupSchedulesFromText(text) {
    // Input example lines (from LOE rawHtml):
    // "Група 1.1. Електроенергії немає з 05:30 до 09:00, з 16:00 до 19:30."
    const lines = normalizeMultilineText(text).split('\n');
    const map = {};
    for (const line of lines) {
        const m = line.match(/Група\s+(\d+\.\d+)\./i);
        if (!m)
            continue;
        const g = normalizeGroupId(m[1]);
        if (!g)
            continue;
        map[g] = line;
    }
    return map;
}
function fetchLoePhotoGraficFirstMenuItem() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const defaultType = 'photo-grafic';
        const type = String((_a = process.env.LOE_MENU_TYPE) !== null && _a !== void 0 ? _a : defaultType);
        const sourceUrl = String((_b = process.env.LOE_MENUS_URL) !== null && _b !== void 0 ? _b : `https://api.loe.lviv.ua/api/menus?page=1&type=${encodeURIComponent(type)}`);
        const res = yield fetch(sourceUrl, {
            headers: {
                accept: 'application/ld+json,application/json;q=0.9,*/*;q=0.8',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            },
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} when calling LOE API`);
        }
        const data = (yield res.json());
        const menu = (_c = data['hydra:member']) === null || _c === void 0 ? void 0 : _c[0];
        const item = (_d = menu === null || menu === void 0 ? void 0 : menu.menuItems) === null || _d === void 0 ? void 0 : _d[0];
        if (!menu || !item) {
            throw new Error('LOE API response did not contain hydra:member[0].menuItems[0]');
        }
        const itemText = textFromRawHtml(item.rawMobileHtml || item.rawHtml);
        const imageUrl = absoluteLoeMediaUrl(item.imageUrl || item.slug);
        return { menuName: menu.name, item, itemText, imageUrl, sourceUrl };
    });
}
function readStateFromDisk() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const raw = yield promises_1.default.readFile(STATE_FILE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' &&
                parsed !== null &&
                'users' in parsed &&
                typeof parsed.users === 'object' &&
                parsed.users !== null) {
                return normalizeStateShape(parsed);
            }
            return { users: {} };
        }
        catch (err) {
            if ((err === null || err === void 0 ? void 0 : err.code) === 'ENOENT')
                return { users: {} };
            // If JSON is corrupt, don't crash the bot — start fresh.
            return { users: {} };
        }
    });
}
function normalizeStateShape(input) {
    const rawUsers = (input === null || input === void 0 ? void 0 : input.users) && typeof input.users === 'object' ? input.users : {};
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
            lastLoeError: typeof u.lastLoeError === 'string' ? u.lastLoeError : undefined,
        };
    }
    return { users };
}
function writeStateToDisk(state) {
    return __awaiter(this, void 0, void 0, function* () {
        const normalized = normalizeStateShape(state);
        const tmp = `${STATE_FILE_PATH}.tmp`;
        yield promises_1.default.writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8');
        yield promises_1.default.rename(tmp, STATE_FILE_PATH);
    });
}
const token = process.env.BOT_TOKEN;
if (!token) {
    throw new Error('Відсутня змінна середовища BOT_TOKEN. Перед запуском бота задайте BOT_TOKEN.');
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
function checkOneChat(chatId_1, user_1) {
    return __awaiter(this, arguments, void 0, function* (chatId, user, forceCheck = false) {
        if (!user.watching && !forceCheck)
            return;
        if (!user.groups || user.groups.length === 0) {
            user.lastLoeError = 'Не задано групи. Використайте /groups та введіть, наприклад: 1.1, 3.2';
            user.lastLoeCheckedAt = new Date().toISOString();
            yield writeStateToDisk(state);
            return;
        }
        try {
            const { itemText, imageUrl } = yield fetchLoePhotoGraficFirstMenuItem();
            const groupMap = parseGroupSchedulesFromText(itemText);
            const selectedLines = user.groups.map((g) => { var _a; return (_a = groupMap[g]) !== null && _a !== void 0 ? _a : `Група ${g}. (Не знайдено в оновленні)`; });
            // Keep the top 2 lines if present (usually "Графік ...", "Інформація станом ...")
            const headerLines = normalizeMultilineText(itemText)
                .split('\n')
                .slice(0, 2)
                .filter((l) => l.length > 0);
            const watchedText = [...headerLines, '', ...selectedLines].join('\n').trim();
            const watchedGroupsText = selectedLines.join('\n').trim();
            const prev = user.lastLoeWatchedText ? extractGroupLinesOnly(user.lastLoeWatchedText) : undefined;
            user.lastLoeCheckedAt = new Date().toISOString();
            user.lastLoeError = undefined;
            if (!prev) {
                user.lastLoeWatchedText = watchedText;
                yield writeStateToDisk(state);
                return;
            }
            if (prev !== watchedGroupsText || forceCheck) {
                user.lastLoeWatchedText = watchedText;
                user.lastLoeNotifiedAt = new Date().toISOString();
                yield writeStateToDisk(state);
                yield bot.telegram.sendMessage(chatId, [
                    forceCheck ? '🔥 Оновлення перевірено!' : '🔥 Графік відключень змінився!',
                    ' ',
                    watchedText || '(Не вдалося прочитати текст)',
                    '',
                    imageUrl ? `\nГрафік відключень: ${imageUrl}` : '',
                ]
                    .filter(Boolean)
                    .join('\n'));
                return;
            }
            yield writeStateToDisk(state);
        }
        catch (err) {
            user.lastLoeCheckedAt = new Date().toISOString();
            user.lastLoeError = (err === null || err === void 0 ? void 0 : err.message) ? String(err.message) : 'Невідома помилка під час перевірки графіка';
            yield writeStateToDisk(state);
        }
    });
}
function checkAllWatchingChats() {
    return __awaiter(this, void 0, void 0, function* () {
        const entries = Object.entries(state.users);
        for (const [chatId, user] of entries) {
            yield checkOneChat(chatId, user);
        }
    });
}
function watchLikeWatchCommand(ctx) {
    return __awaiter(this, void 0, void 0, function* () {
        const chatId = String(ctx.chat.id);
        yield runStateOp(() => __awaiter(this, void 0, void 0, function* () {
            const user = yield ensureUser(chatId);
            user.watching = true;
            yield writeStateToDisk(state);
        }));
        yield ctx.reply(`Перевірка відключень електроенергії увімкнена ✅\nЯ буду перевіряти кожні ${formatInterval(CHECK_EVERY_MS)} та сповіщати вас, якщо графік відключень електроенергії зміниться.`);
        // Do an immediate baseline check (no notification on first snapshot)
        yield runStateOp(() => __awaiter(this, void 0, void 0, function* () {
            const user = yield ensureUser(chatId);
            yield checkOneChat(chatId, user);
        }));
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
        yield ctx.reply('Групи не задані. Використайте /groups (напр: 1.1, 3.2)');
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
            user.lastLoeWatchedText = undefined;
            user.lastLoeError = undefined;
            yield writeStateToDisk(state);
        }));
        const groups = (_d = (_c = state.users[chatId]) === null || _c === void 0 ? void 0 : _c.groups) !== null && _d !== void 0 ? _d : [];
        yield ctx.reply(`Додано ✅\nВи відстежуєте такі групи відключень електроенергії: ${groups.join(', ')}`);
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
            user.lastLoeWatchedText = undefined;
            user.lastLoeError = undefined;
            yield writeStateToDisk(state);
        }));
        const groups = (_d = (_c = state.users[chatId]) === null || _c === void 0 ? void 0 : _c.groups) !== null && _d !== void 0 ? _d : [];
        yield ctx.reply(groups.length ? `Видалено ✅\nТепер групи: ${groups.join(', ')}` : 'Видалено ✅\nГрупи порожні. Використайте /groups');
    });
}
bot.command('remove_group', removeGroupCommand);
// Backward-compatible alias
bot.command('groups_remove', removeGroupCommand);
bot.command('check', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    const chatId = String(ctx.chat.id);
    yield ctx.reply('Перевіряю…');
    yield runStateOp(() => __awaiter(void 0, void 0, void 0, function* () {
        const user = yield ensureUser(chatId);
        yield checkOneChat(chatId, user, true);
    }));
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
                u.lastLoeWatchedText = undefined; // reset snapshot on change
                u.lastLoeError = undefined;
                yield writeStateToDisk(state);
            }));
            yield ctx.reply([
                'Збережено ✅',
                `Групи: ${groups.join(', ')}`,
                '',
                `Сповіщення: УВІМК. (перевіряю кожні ${formatInterval(CHECK_EVERY_MS)})`,
            ].join('\n'));
            // Baseline + immediate forced check to show current info
            yield runStateOp(() => __awaiter(void 0, void 0, void 0, function* () {
                const u = yield ensureUser(chatId);
                yield checkOneChat(chatId, u, true);
            }));
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
                u.lastLoeWatchedText = undefined;
                u.lastLoeError = undefined;
                yield writeStateToDisk(state);
            }));
            const groups = (_c = (_b = state.users[chatId]) === null || _b === void 0 ? void 0 : _b.groups) !== null && _c !== void 0 ? _c : [];
            yield ctx.reply(`Додано ✅\nТепер групи: ${groups.join(', ')}`);
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
                u.lastLoeWatchedText = undefined;
                u.lastLoeError = undefined;
                yield writeStateToDisk(state);
            }));
            const groups = (_e = (_d = state.users[chatId]) === null || _d === void 0 ? void 0 : _d.groups) !== null && _e !== void 0 ? _e : [];
            yield ctx.reply(groups.length ? `Видалено ✅\nТепер групи: ${groups.join(', ')}` : 'Видалено ✅\nГрупи порожні. Використайте /groups');
            return;
        }
    }
}));
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        state = yield readStateFromDisk();
        // Ensure shape
        if (!state.users)
            state.users = {};
        // Make commands show up in Telegram UI ("/" menu)
        try {
            yield bot.telegram.setMyCommands([
                { command: 'start', description: 'Почати роботу' },
                { command: 'groups_list', description: 'Показати вибрані групи' },
                { command: 'add_group', description: 'Додати групи' },
                { command: 'remove_group', description: 'Видалити групи' },
                { command: 'check', description: 'Перевірити зараз' },
            ]);
        }
        catch (_a) {
            // ignore: bot can still run even if Telegram command registration fails
        }
        // Initial check shortly after boot, then every CHECK_EVERY_MS
        setTimeout(() => {
            runStateOp(() => __awaiter(this, void 0, void 0, function* () {
                yield checkAllWatchingChats();
            })).catch(() => undefined);
        }, 2000);
        setInterval(() => {
            console.log('Checking all watching chats...');
            runStateOp(() => __awaiter(this, void 0, void 0, function* () {
                yield checkAllWatchingChats();
            })).catch(() => undefined);
        }, CHECK_EVERY_MS);
        bot.launch();
        // eslint-disable-next-line no-console
        console.log(`Bot is running.. Scheduler interval: ${CHECK_EVERY_MS}ms`);
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
