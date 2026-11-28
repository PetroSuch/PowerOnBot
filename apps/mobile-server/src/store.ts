import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import webPush from 'web-push';
import { POSSIBLE_GROUPS, type MobileDevice, type ScheduleSnapshot } from '@poweron/shared';
import { comparePushSchedule, type Baseline, type PushSubscription } from '@poweron/shared/push';
import { openStatePool, scheduleSchema, scheduleStore, type DatabaseOptions } from '@poweron/shared/schedule-store';

type DeviceUpdate = Pick<MobileDevice, 'name' | 'groups'>;
type PushConfig = { subject: string; publicKey: string; privateKey: string };

const deviceSchema = `
  CREATE TABLE IF NOT EXISTS mobile_devices (
    device_key bytea PRIMARY KEY CHECK (octet_length(device_key) = 32),
    name text CHECK (char_length(name) BETWEEN 1 AND 60),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS mobile_device_groups (
    device_key bytea REFERENCES mobile_devices ON DELETE CASCADE,
    group_id text NOT NULL CHECK (group_id ~ '^(1[0-2]|[1-9])[.][12]$'),
    PRIMARY KEY (device_key, group_id)
  );
  CREATE TABLE IF NOT EXISTS mobile_push_subscriptions (
    device_key bytea PRIMARY KEY REFERENCES mobile_devices ON DELETE CASCADE,
    subscription jsonb NOT NULL,
    baseline jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    revision bigint NOT NULL DEFAULT 0
  )
`;

const selectGroups = `ARRAY(SELECT group_id FROM mobile_device_groups g WHERE g.device_key = d.device_key ORDER BY group_id)`;
const hashDevice = (token: string) => createHash('sha256').update(token).digest();

async function importLegacyDevices(db: Pool) {
  const { rows } = await db.query<{ present: boolean }>("SELECT to_regclass('pwa_push_devices') IS NOT NULL AS present");
  if (!rows[0].present) return;

  await db.query(`
    WITH legacy AS (
      SELECT l.* FROM pwa_push_devices l WHERE to_jsonb(l)->>'user_id' IS NULL
    ), imported AS (
      INSERT INTO mobile_devices (device_key) SELECT device_key FROM legacy
      ON CONFLICT DO NOTHING RETURNING device_key
    ), imported_groups AS (
      INSERT INTO mobile_device_groups (device_key, group_id)
      SELECT i.device_key, g.group_id FROM imported i JOIN legacy l USING (device_key)
      CROSS JOIN LATERAL unnest(l.groups) AS g(group_id) WHERE g.group_id = ANY($1)
      ON CONFLICT DO NOTHING
    )
    INSERT INTO mobile_push_subscriptions (device_key, subscription, baseline, enabled)
    SELECT i.device_key, l.subscription, l.baseline, COALESCE((to_jsonb(l)->>'watching')::boolean, true)
    FROM imported i JOIN legacy l USING (device_key)
  `, [POSSIBLE_GROUPS]);
}

export function parseDeviceUpdate(input: unknown): DeviceUpdate | undefined {
  if (!input || typeof input !== 'object' || !('groups' in input) || !('name' in input)) return;
  const { groups, name } = input;
  if (!Array.isArray(groups) || groups.length > POSSIBLE_GROUPS.length
    || !groups.every((group) => typeof group === 'string' && POSSIBLE_GROUPS.includes(group))) return;
  if (name !== null && (typeof name !== 'string' || [...name.trim()].length > 60 || /[\p{Cc}]/u.test(name))) return;
  return { groups: POSSIBLE_GROUPS.filter((group) => groups.includes(group)), name: name?.trim() || null };
}

async function transaction<T>(db: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function openMobileStore(options: DatabaseOptions, vapid?: PushConfig) {
  if (vapid) webPush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const db = await openStatePool(options, `${scheduleSchema};${deviceSchema};`);
  const schedule = scheduleStore(db);

  try {
    await importLegacyDevices(db);
  } catch (error) {
    await db.end();
    throw error;
  }

  async function getDevice(token: string) {
    return (await db.query<MobileDevice>(`
      SELECT name, ${selectGroups} AS groups, EXISTS (
        SELECT 1 FROM mobile_push_subscriptions p WHERE p.device_key = d.device_key AND p.enabled
      ) AS "notificationsEnabled" FROM mobile_devices d WHERE d.device_key = $1
    `, [hashDevice(token)])).rows[0];
  }

  async function saveDevice(token: string, update: DeviceUpdate, snapshot?: ScheduleSnapshot) {
    const key = hashDevice(token);
    return transaction(db, async (client) => {
      await client.query(`
        INSERT INTO mobile_devices (device_key, name) VALUES ($1, $2)
        ON CONFLICT (device_key) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
      `, [key, update.name]);
      const result = await client.query<{ groups: string[] }>(
        `SELECT ${selectGroups} AS groups FROM mobile_devices d WHERE device_key = $1`, [key],
      );
      const previous = result.rows[0].groups;
      if (previous.length !== update.groups.length || previous.some((group) => !update.groups.includes(group))) {
        await client.query('DELETE FROM mobile_device_groups WHERE device_key = $1', [key]);
        await client.query('INSERT INTO mobile_device_groups SELECT $1, unnest($2::text[])', [key, update.groups]);
        const baseline = snapshot ? comparePushSchedule(snapshot, update.groups).baseline : {};
        await client.query(`
          UPDATE mobile_push_subscriptions SET baseline = $2, revision = revision + 1
          WHERE device_key = $1
        `, [key, baseline]);
      }
      const subscription = await client.query('SELECT 1 FROM mobile_push_subscriptions WHERE device_key = $1 AND enabled', [key]);
      return { ...update, notificationsEnabled: subscription.rowCount === 1 };
    });
  }

  async function subscribe(token: string, subscription: PushSubscription, snapshot?: ScheduleSnapshot) {
    const key = hashDevice(token);
    return transaction(db, async (client) => {
      const result = await client.query<{ groups: string[] }>(`
        SELECT ${selectGroups} AS groups FROM mobile_devices d WHERE device_key = $1 FOR UPDATE
      `, [key]);
      const groups = result.rows[0]?.groups;
      if (!groups?.length) return false;
      const baseline = snapshot ? comparePushSchedule(snapshot, groups).baseline : {};
      await client.query(`
        INSERT INTO mobile_push_subscriptions (device_key, subscription, baseline) VALUES ($1, $2, $3)
        ON CONFLICT (device_key) DO UPDATE SET subscription = EXCLUDED.subscription,
          baseline = EXCLUDED.baseline, enabled = true, revision = mobile_push_subscriptions.revision + 1
        WHERE mobile_push_subscriptions.subscription IS DISTINCT FROM EXCLUDED.subscription
          OR NOT mobile_push_subscriptions.enabled
      `, [key, subscription, baseline]);
      return true;
    });
  }

  async function publish(snapshot: ScheduleSnapshot) {
    if (!vapid) return;
    const { rows } = await db.query<{
      device_key: Buffer; subscription: PushSubscription; baseline: Baseline; groups: string[]; revision: string;
    }>(`
      SELECT p.device_key, p.subscription, p.baseline, p.revision, ${selectGroups} AS groups
      FROM mobile_push_subscriptions p JOIN mobile_devices d USING (device_key) WHERE p.enabled
    `);
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
            }), { vapidDetails: vapid, TTL: 1800, timeout: 5000 });
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await db.query('DELETE FROM mobile_push_subscriptions WHERE device_key = $1 AND revision = $2',
                [device.device_key, device.revision]);
            } else {
              console.error('[Mobile] Push delivery failed', status ?? '');
            }
            return;
          }
        }
        await db.query('UPDATE mobile_push_subscriptions SET baseline = $1 WHERE device_key = $2 AND revision = $3',
          [baseline, device.device_key, device.revision]);
      }));
    }
  }

  return {
    ...schedule,
    publicKey: vapid?.publicKey ?? null,
    getDevice, saveDevice, subscribe, publish,
    async unsubscribe(token: string) {
      await db.query('DELETE FROM mobile_push_subscriptions WHERE device_key = $1', [hashDevice(token)]);
    },
  };
}

export type MobileStore = Awaited<ReturnType<typeof openMobileStore>>;
