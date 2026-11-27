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
Object.defineProperty(exports, "__esModule", { value: true });
exports.kyivTimeFormatter = exports.POSSIBLE_GROUPS = exports.REFRESH_INTERVAL_MS = void 0;
exports.kyivDate = kyivDate;
exports.normalizeGroupId = normalizeGroupId;
exports.parseScheduleText = parseScheduleText;
exports.dateFromHeading = dateFromHeading;
exports.parseScheduleFeed = parseScheduleFeed;
exports.createScheduleFeed = createScheduleFeed;
const cheerio_1 = require("cheerio");
exports.REFRESH_INTERVAL_MS = 10 * 60 * 1000;
exports.POSSIBLE_GROUPS = [
    '1.1', '1.2', '2.1', '2.2', '3.1', '3.2',
    '4.1', '4.2', '5.1', '5.2', '6.1', '6.2',
];
const kyivDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', dateStyle: 'short' });
exports.kyivTimeFormatter = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    dateStyle: 'short',
    timeStyle: 'short',
});
function kyivDate(time, daysAhead = 0) {
    var _a, _b, _c;
    const parts = kyivDateFormatter.formatToParts(time);
    const year = Number((_a = parts.find((part) => part.type === 'year')) === null || _a === void 0 ? void 0 : _a.value);
    const month = Number((_b = parts.find((part) => part.type === 'month')) === null || _b === void 0 ? void 0 : _b.value);
    const day = Number((_c = parts.find((part) => part.type === 'day')) === null || _c === void 0 ? void 0 : _c.value);
    // Shift the calendar date after converting to Kyiv time so DST cannot change the result.
    return new Date(Date.UTC(year, month - 1, day + daysAhead)).toISOString().slice(0, 10);
}
function normalizeGroupId(raw) {
    const match = raw.trim().match(/^(\d+)[.,](\d+)$/);
    return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}
function cleanLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function parseScheduleText(text) {
    var _a, _b, _c;
    const matches = [...text.matchAll(/Група\s+(\d+[.,]\d+)\s*[.:]/gi)];
    const headers = text.slice(0, (_b = (_a = matches[0]) === null || _a === void 0 ? void 0 : _a.index) !== null && _b !== void 0 ? _b : text.length).split('\n').map(cleanLine).filter(Boolean).slice(0, 2);
    const groups = {};
    for (const [index, match] of matches.entries()) {
        const group = normalizeGroupId(match[1]);
        const line = cleanLine(text.slice(match.index + match[0].length, (_c = matches[index + 1]) === null || _c === void 0 ? void 0 : _c.index));
        if (group && exports.POSSIBLE_GROUPS.includes(group) && line)
            groups[group] = line;
    }
    return { headers, groups };
}
function textFromHtml(html) {
    const $ = (0, cheerio_1.load)(html);
    $('script, style').remove();
    $('br').replaceWith('\n');
    $('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article').after('\n');
    return $('body').text();
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function dateFromHeading(heading) {
    const match = heading.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
    if (!match)
        return undefined;
    const date = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    const parsed = new Date(date);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date) ? date : undefined;
}
function parseScheduleFeed(data, fetchedAt) {
    var _a, _b;
    const menus = Array.isArray(data) ? data : (_a = asRecord(data)) === null || _a === void 0 ? void 0 : _a['hydra:member'];
    const items = Array.isArray(menus) ? (_b = asRecord(menus[0])) === null || _b === void 0 ? void 0 : _b.menuItems : undefined;
    if (!Array.isArray(items)) {
        throw new Error('LOE API response did not contain valid menuItems');
    }
    const entries = items.map(asRecord);
    if (entries.some((item) => typeof (item === null || item === void 0 ? void 0 : item.name) !== 'string')) {
        throw new Error('LOE API response contained an invalid menu item');
    }
    function readDay(name, daysAhead) {
        var _a, _b;
        const item = entries.find((entry) => (entry === null || entry === void 0 ? void 0 : entry.name) === name);
        if (!item)
            return undefined;
        const versions = [item.rawMobileHtml, item.rawHtml];
        if (versions.some((html) => html != null && typeof html !== 'string')) {
            throw new Error(`LOE API returned invalid HTML for ${name}`);
        }
        const source = versions.filter((html) => typeof html === 'string')
            .map(textFromHtml).filter((content) => content.trim());
        for (const content of source) {
            const { headers, groups } = parseScheduleText(content);
            if (!Object.keys(groups).length)
                continue;
            const media = [item.imageUrl, item.slug].find((value) => typeof value === 'string' && !!value.trim());
            const imageUrl = media ? new URL(media, 'https://api.loe.lviv.ua').href : '';
            return {
                date: (_b = dateFromHeading((_a = headers[0]) !== null && _a !== void 0 ? _a : '')) !== null && _b !== void 0 ? _b : kyivDate(fetchedAt, daysAhead),
                headers,
                groups,
                imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : '',
            };
        }
        if (source.length)
            throw new Error(`LOE API returned no readable group schedules for ${name}`);
        return undefined;
    }
    const today = readDay('Today', 0);
    const tomorrow = readDay('Tomorrow', 1);
    if (!today && !tomorrow)
        throw new Error('LOE API response did not contain readable schedules');
    return { fetchedAt, today, tomorrow };
}
function fetchSchedule() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const type = (_a = process.env.LOE_MENU_TYPE) !== null && _a !== void 0 ? _a : 'photo-grafic';
        const url = (_b = process.env.LOE_MENUS_URL) !== null && _b !== void 0 ? _b : `https://api.loe.lviv.ua/api/menus?page=1&type=${encodeURIComponent(type)}`;
        const res = yield fetch(url, {
            headers: {
                accept: 'application/ld+json,application/json;q=0.9,*/*;q=0.8',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
            },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok)
            throw new Error(`HTTP ${res.status} when calling LOE API`);
        const data = yield res.json();
        return parseScheduleFeed(data, Date.now());
    });
}
function createScheduleFeed(fetchSnapshot = fetchSchedule, now = Date.now, log = console.info) {
    let latest = {};
    let nextFetchAt = 0;
    let fetchCount = 0;
    let inFlight;
    function refresh(trigger) {
        if (inFlight) {
            log(`[LOE] ${trigger} check joined in-flight fetch #${fetchCount}`);
            return inFlight;
        }
        const startedAt = now();
        if (startedAt < nextFetchAt) {
            const result = latest.snapshot ? 'using cached schedule' : 'no saved schedule available';
            log(`[LOE] ${trigger} check skipped upstream fetch after fetch #${fetchCount} (${result}, retry in ${Math.ceil((nextFetchAt - startedAt) / 1000)}s)`);
            return Promise.resolve(latest);
        }
        const fetchNumber = ++fetchCount;
        log(`[LOE] Upstream fetch #${fetchNumber} started (${trigger}) at ${new Date(startedAt).toISOString()}`);
        inFlight = Promise.resolve()
            .then(fetchSnapshot)
            .then((snapshot) => {
            latest = { snapshot };
            log(`[LOE] Upstream fetch #${fetchNumber} succeeded in ${now() - startedAt}ms`);
            return latest;
        })
            .catch((error) => {
            latest = { snapshot: latest.snapshot, error: error instanceof Error ? error.message : String(error) };
            log(`[LOE] Upstream fetch #${fetchNumber} failed in ${now() - startedAt}ms: ${latest.error}`);
            return latest;
        })
            .finally(() => {
            nextFetchAt = now() + exports.REFRESH_INTERVAL_MS;
            inFlight = undefined;
        });
        return inFlight;
    }
    return {
        refresh,
        read: () => latest,
        nextFetchAt: () => nextFetchAt,
    };
}
