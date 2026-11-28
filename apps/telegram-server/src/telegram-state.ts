import { openStatePool, scheduleSchema, scheduleStore, type DatabaseOptions } from '@poweron/shared/schedule-store';

export { openScheduleStore } from '@poweron/shared/schedule-store';

type StoredState<T> = { snapshot: T; revision: number };

export async function openTelegramState<T>(
  options: DatabaseOptions & { botId: string },
  readLegacy: () => Promise<T>,
) {
  const { botId } = options;
  const pool = await openStatePool(options, `
    CREATE TABLE IF NOT EXISTS telegram_bot_state (
      bot_id text PRIMARY KEY,
      snapshot jsonb NOT NULL CHECK (
        jsonb_typeof(snapshot) = 'object' AND snapshot ? 'users'
        AND jsonb_typeof(snapshot->'users') = 'object'
      ),
      revision integer NOT NULL DEFAULT 0
    );
    ${scheduleSchema}
  `);

  async function read() {
    const result = await pool.query<StoredState<T>>(
      'SELECT snapshot, revision FROM telegram_bot_state WHERE bot_id = $1', [botId],
    );
    return result.rows[0];
  }

  try {
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
      ...scheduleStore(pool),
      state: stored.snapshot,
      initialized,
      async save(state: T) {
        const result = await pool.query<{ revision: number }>(`
          UPDATE telegram_bot_state SET snapshot = $1, revision = revision + 1
          WHERE bot_id = $2 AND revision = $3
          RETURNING revision
        `, [JSON.stringify(state), botId, revision]);
        if (!result.rows[0]) throw new Error('Telegram state changed in PostgreSQL. Restart the bot to reload it.');
        revision = result.rows[0].revision;
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
