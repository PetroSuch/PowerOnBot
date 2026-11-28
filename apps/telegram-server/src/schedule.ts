import { load } from 'cheerio';
import { POSSIBLE_GROUPS, type ScheduleDay, type ScheduleSnapshot } from '@poweron/shared';

export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

type RefreshResult = {
  snapshot?: ScheduleSnapshot;
  error?: string;
};

const kyivDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', dateStyle: 'short' });
export const kyivTimeFormatter = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv',
  dateStyle: 'short',
  timeStyle: 'short',
});

export function kyivDate(time: number, daysAhead = 0): string {
  const parts = kyivDateFormatter.formatToParts(time);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  // Shift the calendar date after converting to Kyiv time so DST cannot change the result.
  return new Date(Date.UTC(year, month - 1, day + daysAhead)).toISOString().slice(0, 10);
}

export function normalizeGroupId(raw: string): string | null {
  const match = raw.trim().match(/^(\d+)[.,](\d+)$/);
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

function cleanLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function parseScheduleText(text: string): { headers: string[]; groups: Record<string, string> } {
  const matches = [...text.matchAll(/Група\s+(\d+[.,]\d+)\s*[.:]/gi)];
  const headers = text.slice(0, matches[0]?.index ?? text.length).split('\n').map(cleanLine).filter(Boolean).slice(0, 2);
  const groups: Record<string, string> = {};
  for (const [index, match] of matches.entries()) {
    const group = normalizeGroupId(match[1]);
    const line = cleanLine(text.slice(match.index + match[0].length, matches[index + 1]?.index));
    if (group && POSSIBLE_GROUPS.includes(group) && line) groups[group] = line;
  }
  return { headers, groups };
}

function textFromHtml(html: string): string {
  const $ = load(html);
  $('script, style').remove();
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article').after('\n');
  return $('body').text();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function dateFromHeading(heading: string): string | undefined {
  const match = heading.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (!match) return undefined;
  const date = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date) ? date : undefined;
}

export function parseScheduleFeed(data: unknown, fetchedAt: number): ScheduleSnapshot {
  const menus = Array.isArray(data) ? data : asRecord(data)?.['hydra:member'];
  const items = Array.isArray(menus) ? asRecord(menus[0])?.menuItems : undefined;
  if (!Array.isArray(items)) {
    throw new Error('LOE API response did not contain valid menuItems');
  }
  const entries = items.map(asRecord);
  if (entries.some((item) => typeof item?.name !== 'string')) {
    throw new Error('LOE API response contained an invalid menu item');
  }

  function readDay(name: string, daysAhead: number): ScheduleDay | undefined {
    const item = entries.find((entry) => entry?.name === name);
    if (!item) return undefined;
    const versions = [item.rawMobileHtml, item.rawHtml];
    if (versions.some((html) => html != null && typeof html !== 'string')) {
      throw new Error(`LOE API returned invalid HTML for ${name}`);
    }
    const source = versions.filter((html): html is string => typeof html === 'string')
      .map(textFromHtml).filter((content) => content.trim());
    for (const content of source) {
      const { headers, groups } = parseScheduleText(content);
      if (!Object.keys(groups).length) continue;
      const media = [item.imageUrl, item.slug].find((value): value is string => typeof value === 'string' && !!value.trim());
      const imageUrl = media ? new URL(media, 'https://api.loe.lviv.ua').href : '';
      return {
        date: dateFromHeading(headers[0] ?? '') ?? kyivDate(fetchedAt, daysAhead),
        headers,
        groups,
        imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : '',
      };
    }
    if (source.length) throw new Error(`LOE API returned no readable group schedules for ${name}`);
    return undefined;
  }

  const today = readDay('Today', 0);
  const tomorrow = readDay('Tomorrow', 1);
  if (!today && !tomorrow) throw new Error('LOE API response did not contain readable schedules');
  return { fetchedAt, today, tomorrow };
}

async function fetchSchedule(): Promise<ScheduleSnapshot> {
  const type = process.env.LOE_MENU_TYPE ?? 'photo-grafic';
  const url = process.env.LOE_MENUS_URL ?? `https://api.loe.lviv.ua/api/menus?page=1&type=${encodeURIComponent(type)}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/ld+json,application/json;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} when calling LOE API`);
  const data: unknown = await res.json();
  return parseScheduleFeed(data, Date.now());
}

export function createScheduleFeed(fetchSnapshot = fetchSchedule, now = Date.now, log = console.info) {
  let latest: RefreshResult = {};
  let nextFetchAt = 0;
  let fetchCount = 0;
  let inFlight: Promise<RefreshResult> | undefined;

  function refresh(trigger: 'scheduled' | 'manual'): Promise<RefreshResult> {
    if (inFlight) {
      log(`[LOE] ${trigger} check joined in-flight fetch #${fetchCount}`);
      return inFlight;
    }
    const startedAt = now();
    if (startedAt < nextFetchAt) {
      const result = latest.snapshot ? 'using cached schedule' : 'no saved schedule available';
      const previousRequest = fetchCount ? ` after fetch #${fetchCount}` : '';
      log(`[LOE] ${trigger} check skipped upstream fetch${previousRequest} (${result}, retry in ${Math.ceil((nextFetchAt - startedAt) / 1000)}s)`);
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
      .catch((error: unknown) => {
        latest = { snapshot: latest.snapshot, error: error instanceof Error ? error.message : String(error) };
        log(`[LOE] Upstream fetch #${fetchNumber} failed in ${now() - startedAt}ms: ${latest.error}`);
        return latest;
      })
      .finally(() => {
        nextFetchAt = now() + REFRESH_INTERVAL_MS;
        inFlight = undefined;
      });
    return inFlight;
  }

  return {
    refresh,
    restore(snapshot: ScheduleSnapshot, fetchAt: number) {
      latest = { snapshot };
      nextFetchAt = fetchAt;
    },
    read: () => latest,
    nextFetchAt: () => nextFetchAt,
  };
}
