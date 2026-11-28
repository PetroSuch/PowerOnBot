import { POSSIBLE_GROUPS, type ScheduleDay, type ScheduleSnapshot } from './index';
import { kyivDate } from './schedule';

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

type DayBaseline = { date: string; groups: Record<string, string | null> };
export type Baseline = { today?: DayBaseline; tomorrow?: DayBaseline };
function selectedDay(day: ScheduleDay | undefined, date: string, groups: string[]): DayBaseline | undefined {
  if (day?.date !== date || !groups.some((group) => typeof day.groups[group] === 'string')) return undefined;
  return { date, groups: Object.fromEntries(groups.map((group) => [group, day.groups[group] ?? null])) };
}

export function comparePushSchedule(snapshot: ScheduleSnapshot, groups: string[], previous: Baseline = {}) {
  const today = selectedDay(snapshot.today, kyivDate(snapshot.fetchedAt), groups);
  const tomorrow = selectedDay(snapshot.tomorrow, kyivDate(snapshot.fetchedAt, 1), groups);
  const changed = (current: DayBaseline, old: DayBaseline) =>
    current.date !== old.date || groups.some((group) => current.groups[group] !== old.groups[group]);
  const alerts: string[] = [];
  if (today && previous.today && changed(today, previous.today)) alerts.push('Оновився графік на сьогодні');
  if (tomorrow && (!previous.tomorrow || changed(tomorrow, previous.tomorrow))) alerts.push('Оновився графік на завтра');
  return {
    baseline: { today: today ?? previous.today, tomorrow: tomorrow ?? previous.tomorrow },
    alerts,
  };
}

export function parsePushRegistration(value: unknown): { subscription: PushSubscription; groups: string[] } | undefined {
  if (!value || typeof value !== 'object' || !('subscription' in value) || !('groups' in value)) return;
  const { subscription, groups } = value;
  if (!Array.isArray(groups) || !groups.length || groups.length > POSSIBLE_GROUPS.length
    || !groups.every((group) => typeof group === 'string' && POSSIBLE_GROUPS.includes(group))) return;
  const parsed = parsePushSubscription(subscription);
  if (parsed) return { subscription: parsed, groups: [...new Set(groups)] };
}

export function parsePushSubscription(subscription: unknown): PushSubscription | undefined {
  if (!subscription || typeof subscription !== 'object' || !('endpoint' in subscription) || !('keys' in subscription)) return;
  const { endpoint, keys } = subscription;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !keys || typeof keys !== 'object'
    || !('p256dh' in keys) || !('auth' in keys) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
    || !/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(keys.auth)) return;

  const url = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com'
      || url.hostname.endsWith('.push.apple.com'))) return;
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
