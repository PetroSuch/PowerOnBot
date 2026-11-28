import { Client, Pool } from 'pg';
import type { ScheduleSnapshot } from './index';

export type DatabaseOptions = { databaseUrl: string; directUrl?: string };

export const scheduleSchema = `
  CREATE TABLE IF NOT EXISTS poweron_schedule (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    snapshot jsonb NOT NULL,
    fetched_at bigint NOT NULL,
    next_fetch_at bigint NOT NULL
  )
`;

export function scheduleStore(pool: Pool) {
  return {
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
    close: () => pool.end(),
  };
}

export async function openStatePool({ databaseUrl, directUrl }: DatabaseOptions, schema: string) {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('[State] PostgreSQL connection error'));
  const direct = directUrl ? new Client({ connectionString: directUrl, connectionTimeoutMillis: 5000 }) : undefined;
  try {
    try {
      await direct?.connect();
      await (direct ?? pool).query(schema);
    } finally {
      await direct?.end();
    }
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function openScheduleStore(options: DatabaseOptions) {
  return scheduleStore(await openStatePool(options, scheduleSchema));
}
