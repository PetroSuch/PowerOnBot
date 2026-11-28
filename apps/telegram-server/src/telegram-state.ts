import { Client, Pool } from 'pg';
import type { ScheduleSnapshot } from '@poweron/shared';

type StoredState<T> = { snapshot: T; revision: number };

export async function openTelegramState<T>(
  options: { databaseUrl: string; directUrl?: string; botId: string },
  readLegacy: () => Promise<T>,
) {
  const { databaseUrl, directUrl, botId } = options;
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('[State] PostgreSQL connection error'));

  async function read() {
    const result = await pool.query<StoredState<T>>(
      'SELECT snapshot, revision FROM telegram_bot_state WHERE bot_id = $1', [botId],
    );
    return result.rows[0];
  }

  try {
    const direct = directUrl ? new Client({ connectionString: directUrl, connectionTimeoutMillis: 5000 }) : undefined;
    try {
      await direct?.connect();
      await (direct ?? pool).query(`
        CREATE TABLE IF NOT EXISTS telegram_bot_state (
          bot_id text PRIMARY KEY,
          snapshot jsonb NOT NULL CHECK (
            jsonb_typeof(snapshot) = 'object' AND snapshot ? 'users'
            AND jsonb_typeof(snapshot->'users') = 'object'
          ),
          revision integer NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS poweron_schedule (
          id boolean PRIMARY KEY DEFAULT true CHECK (id),
          snapshot jsonb NOT NULL,
          fetched_at bigint NOT NULL,
          next_fetch_at bigint NOT NULL
        )
      `);
    } finally {
      await direct?.end();
    }

    let stored = await read();
    let initialized = false;
    if (!stored) {
      const legacy = await readLegacy();
      const inserted = await pool.query<StoredState<T>>(`
        INSERT INTO telegram_bot_state (bot_id, snapshot) VALUES ($1, $2)
        ON CONFLICT (bot_id) DO NOTHING
        RETURNING snapshot, revision
      `, [botId, JSON.stringify(legacy)]);
      initialized = inserted.rowCount === 1;
      stored = inserted.rows[0] ?? await read();
    }
    if (!stored) throw new Error('Telegram state could not be initialized in PostgreSQL');
    let revision = stored.revision;

    return {
      state: stored.snapshot,
      initialized,
      async readSchedule() {
        const result = await pool.query<{ snapshot: ScheduleSnapshot; next_fetch_at: string }>(
          'SELECT snapshot, next_fetch_at FROM poweron_schedule WHERE id',
        );
        const row = result.rows[0];
        return row ? { snapshot: row.snapshot, nextFetchAt: Number(row.next_fetch_at) } : undefined;
      },
      async saveSchedule(snapshot: ScheduleSnapshot, nextFetchAt: number) {
        await pool.query(`
          INSERT INTO poweron_schedule (id, snapshot, fetched_at, next_fetch_at) VALUES (true, $1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot,
            fetched_at = EXCLUDED.fetched_at, next_fetch_at = EXCLUDED.next_fetch_at
          WHERE poweron_schedule.fetched_at < EXCLUDED.fetched_at
        `, [JSON.stringify(snapshot), snapshot.fetchedAt, nextFetchAt]);
      },
      async save(state: T) {
        const result = await pool.query<{ revision: number }>(`
          UPDATE telegram_bot_state SET snapshot = $1, revision = revision + 1
          WHERE bot_id = $2 AND revision = $3
          RETURNING revision
        `, [JSON.stringify(state), botId, revision]);
        if (!result.rows[0]) throw new Error('Telegram state changed in PostgreSQL. Restart the bot to reload it.');
        revision = result.rows[0].revision;
      },
      close: () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
