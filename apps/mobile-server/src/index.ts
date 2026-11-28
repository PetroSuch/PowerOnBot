import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ScheduleResponse } from '@poweron/shared';
import { createScheduleFeed } from '@poweron/shared/schedule';
import { createMobileHandler } from './http';
import { openMobileStore } from './store';

const root = path.resolve(__dirname, '../../..');
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(path.join(root, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function main() {
  const { DATABASE_URL, DATABASE_URL_UNPOOLED, VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  const port = Number(process.env.PORT ?? process.env.PWA_PORT ?? 8080);
  const host = process.env.PWA_HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port');
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for mobile device profiles');
  const vapid = VAPID_SUBJECT && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY
    ? { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY }
    : undefined;
  if (!vapid && (VAPID_SUBJECT || VAPID_PUBLIC_KEY || VAPID_PRIVATE_KEY)) {
    throw new Error('Set all three VAPID variables to enable Web Push');
  }
  const directory = path.join(root, 'apps/mobile/dist/browser');
  await fs.access(path.join(directory, 'index.html'));
  const store = await openMobileStore({ databaseUrl: DATABASE_URL, directUrl: DATABASE_URL_UNPOOLED }, vapid);
  try {
    const feed = createScheduleFeed();
    const saved = await store.readSchedule();
    if (saved) feed.restore(saved.snapshot, saved.nextFetchAt);
    const read = (): ScheduleResponse => {
      const { snapshot, error } = feed.read();
      return { snapshot, refreshFailed: !!error, nextFetchAt: feed.nextFetchAt() };
    };

    let lastProcessed = 0;
    let delivery = Promise.resolve();
    async function refresh(trigger: 'manual' | 'scheduled') {
      await feed.refresh(trigger);
      const response = read();
      const snapshot = response.snapshot;
      if (!response.refreshFailed && snapshot && snapshot.fetchedAt > lastProcessed) {
        lastProcessed = snapshot.fetchedAt;
        delivery = delivery.then(async () => {
          await store.saveSchedule(snapshot, response.nextFetchAt);
          await store.publish(snapshot);
        }).catch(() => {
          if (lastProcessed === snapshot.fetchedAt) lastProcessed = 0;
          console.error('[Mobile] Schedule persistence or delivery failed');
        });
      }
      return response;
    }

    const webDirectory = path.join(root, 'apps', 'web', 'dist', 'browser');
    const server = createServer(createMobileHandler(directory, { read, refresh: () => refresh('manual') }, store, webDirectory));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    console.info('[Mobile] Listening on http://' + host + ':' + port);
    const timer = setInterval(() => void refresh('scheduled'), 15 * 60 * 1000);
    void refresh('scheduled');

    function stop() {
      clearInterval(timer);
      server.close(() => { void delivery.finally(() => store.close()); });
    }
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    await store.close();
    throw error;
  }
}
void main().catch((error: unknown) => {
  console.error('[Mobile] Startup failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
