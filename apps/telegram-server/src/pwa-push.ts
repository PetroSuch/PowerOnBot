import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import webPush, { type PushSubscription } from 'web-push';
import { POSSIBLE_GROUPS, type ScheduleDay, type ScheduleSnapshot } from '@poweron/shared';
import { kyivDate } from './schedule';

type DayBaseline = { date: string; groups: Record<string, string | null> };
type Baseline = { today?: DayBaseline; tomorrow?: DayBaseline };
type Device = {
  device_key: Buffer;
  subscription: PushSubscription;
  groups: string[];
  baseline: Baseline;
  revision: number;
};

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
  if (!subscription || typeof subscription !== 'object' || !('endpoint' in subscription) || !('keys' in subscription)) return;
  const { endpoint, keys } = subscription;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !keys || typeof keys !== 'object'
    || !('p256dh' in keys) || !('auth' in keys) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
    || !/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(keys.auth)) return;

  const url = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com'
      || url.hostname.endsWith('.push.apple.com'))) return;
  return { subscription: { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } }, groups: [...new Set(groups)] };
}

export async function createPwaPushService() {
  const { DATABASE_URL, VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_SUBJECT && !VAPID_PUBLIC_KEY && !VAPID_PRIVATE_KEY) return undefined;
  if (!DATABASE_URL || !VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('PWA push requires DATABASE_URL, VAPID_SUBJECT, VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY');
  }
  const vapidDetails = { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
  webPush.setVapidDetails(vapidDetails.subject, vapidDetails.publicKey, vapidDetails.privateKey);
  const db = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  db.on('error', () => console.error('[PWA] PostgreSQL connection error'));
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS pwa_push_devices (
        device_key bytea PRIMARY KEY,
        subscription jsonb NOT NULL,
        groups text[] NOT NULL,
        baseline jsonb NOT NULL,
        revision integer NOT NULL DEFAULT 0
      )
    `);
  } catch (error) {
    await db.end();
    throw error;
  }

  const deviceKey = (token: string) => createHash('sha256').update(token).digest();

  async function publish(snapshot: ScheduleSnapshot) {
    const { rows } = await db.query<Device>('SELECT * FROM pwa_push_devices');
    for (let index = 0; index < rows.length; index += 10) {
      await Promise.all(rows.slice(index, index + 10).map(async (device) => {
        const { baseline, alerts } = comparePushSchedule(snapshot, device.groups, device.baseline);
        if (!alerts.length && (device.baseline.today || !baseline.today)) return;
        if (alerts.length) {
          try {
            await webPush.sendNotification(device.subscription, JSON.stringify({
              notification: {
                title: 'PowerOn · Графік відключень',
                body: `${alerts.join('. ')}. Групи ${device.groups.join(', ')}.`,
                icon: '/icons/icon-192.png',
                data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/' } } },
              },
            }), { vapidDetails, TTL: 1800, timeout: 5000 });
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await db.query('DELETE FROM pwa_push_devices WHERE device_key = $1 AND revision = $2',
                [device.device_key, device.revision]);
            } else {
              console.error('[PWA] Push delivery failed', status ?? '');
            }
            return;
          }
        }
        await db.query('UPDATE pwa_push_devices SET baseline = $1 WHERE device_key = $2 AND revision = $3',
          [baseline, device.device_key, device.revision]);
      }));
    }
  }

  return {
    publicKey: VAPID_PUBLIC_KEY,
    async save(token: string, subscription: PushSubscription, groups: string[], snapshot?: ScheduleSnapshot) {
      const baseline = snapshot ? comparePushSchedule(snapshot, groups).baseline : {};
      await db.query(`
        INSERT INTO pwa_push_devices (device_key, subscription, groups, baseline)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (device_key) DO UPDATE SET subscription = EXCLUDED.subscription, groups = EXCLUDED.groups,
          baseline = EXCLUDED.baseline, revision = pwa_push_devices.revision + 1
        WHERE pwa_push_devices.subscription IS DISTINCT FROM EXCLUDED.subscription
          OR pwa_push_devices.groups IS DISTINCT FROM EXCLUDED.groups
      `, [deviceKey(token), subscription, groups, baseline]);
    },
    async remove(token: string) {
      await db.query('DELETE FROM pwa_push_devices WHERE device_key = $1', [deviceKey(token)]);
    },
    publish,
    close: () => db.end(),
  };
}

export type PwaPushService = NonNullable<Awaited<ReturnType<typeof createPwaPushService>>>;
