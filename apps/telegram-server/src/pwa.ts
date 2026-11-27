import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type ScheduleResponse } from '@poweron/shared';
import { createPwaPushService, parsePushRegistration, type PwaPushService } from './pwa-push';

type ScheduleSource = {
  read: () => ScheduleResponse;
  refresh: () => Promise<ScheduleResponse>;
};

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Expected JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createPwaHandler(directory: string, schedule: ScheduleSource, push?: PwaPushService) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return json(res, 400, { error: 'Invalid URL' });
    }

    try {
      if (pathname === '/api/schedule' && req.method === 'GET') return json(res, 200, schedule.read());
      if (pathname === '/api/schedule/refresh' && req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
          return json(res, 415, { error: 'Expected JSON' });
        }
        return json(res, 200, await schedule.refresh());
      }
      if (pathname === '/api/push/config' && req.method === 'GET') {
        return json(res, 200, { publicKey: push?.publicKey ?? null });
      }
      if (pathname === '/api/push/subscription' && (req.method === 'PUT' || req.method === 'DELETE')) {
        if (!push) return json(res, 503, { error: 'Push is unavailable' });
        const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!token) return json(res, 401, { error: 'Invalid device token' });
        if (req.method === 'DELETE') {
          await push.remove(token);
        } else {
          const registration = parsePushRegistration(await readJson(req).catch(() => undefined));
          if (!registration) return json(res, 400, { error: 'Invalid subscription or groups' });
          await push.save(token, registration.subscription, registration.groups, schedule.read().snapshot);
        }
        res.writeHead(204).end();
        return;
      }
      if (pathname.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) {
        return json(res, 404, { error: 'Not found' });
      }

      const file = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
      const type = mime[path.extname(file)];
      if (!file.startsWith(directory + path.sep) || !type) return json(res, 404, { error: 'Not found' });
      const body = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return json(res, 404, { error: 'Not found' });
      console.error('[PWA] Request failed', code ?? '');
      return json(res, 500, { error: 'Server error' });
    }
  };
}

export async function startPwaServer(directory: string, schedule: ScheduleSource) {
  const port = Number(process.env.PWA_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PWA_PORT must be a valid port');
  await fs.access(path.join(directory, 'index.html'));
  const push = await createPwaPushService();
  const host = process.env.PWA_HOST ?? '127.0.0.1';
  const server = createServer(createPwaHandler(directory, schedule, push));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await push?.close();
    throw error;
  }
  console.info(`[PWA] Listening on http://${host}:${port}`);
  return {
    push,
    close() {
      server.close();
      void push?.close().catch(() => console.error('[PWA] PostgreSQL shutdown failed'));
    },
  };
}
