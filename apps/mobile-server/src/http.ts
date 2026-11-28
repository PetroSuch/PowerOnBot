import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ScheduleResponse } from '@poweron/shared';
import { parsePushSubscription } from '@poweron/shared/push';
import { parseDeviceUpdate, type MobileStore } from './store';

type Schedule = { read(): ScheduleResponse; refresh(): Promise<ScheduleResponse> };
type Devices = Pick<MobileStore, 'getDevice' | 'saveDevice' | 'subscribe' | 'unsubscribe' | 'publicKey'>;

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8192) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function createMobileHandler(directory: string, schedule: Schedule, devices: Devices, webDirectory?: string) {
  const root = path.resolve(directory);
  const webRoot = webDirectory && path.resolve(webDirectory);
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      const method = req.method;
      if (pathname === '/api/schedule' && method === 'GET') return json(res, 200, schedule.read());
      if (pathname === '/api/schedule/refresh' && method === 'POST') {
        if (!await readJson(req)) return json(res, 400, { error: 'Expected JSON' });
        return json(res, 200, await schedule.refresh());
      }
      if (pathname === '/api/push/config' && method === 'GET') return json(res, 200, { publicKey: devices.publicKey });

      if (pathname === '/api/device' || pathname === '/api/push/subscription') {
        const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!token) return json(res, 401, { error: 'Invalid device token' });
        if (pathname === '/api/device') {
          if (method === 'GET') {
            const device = await devices.getDevice(token);
            return device ? json(res, 200, device) : json(res, 404, { error: 'Device not found' });
          }
          if (method === 'PUT') {
            const update = parseDeviceUpdate(await readJson(req));
            if (!update) return json(res, 400, { error: 'Invalid profile or groups' });
            return json(res, 200, await devices.saveDevice(token, update, schedule.read().snapshot));
          }
        } else if (method === 'PUT') {
          if (!devices.publicKey) return json(res, 503, { error: 'Push is unavailable' });
          const subscription = parsePushSubscription(await readJson(req));
          if (!subscription) return json(res, 400, { error: 'Invalid subscription' });
          if (!await devices.subscribe(token, subscription, schedule.read().snapshot)) {
            return json(res, 409, { error: 'Save at least one group before subscribing' });
          }
          res.writeHead(204).end();
          return;
        } else if (method === 'DELETE') {
          await devices.unsubscribe(token);
          res.writeHead(204).end();
          return;
        }
        return json(res, 405, { error: 'Method not allowed' });
      }

      if (pathname.startsWith('/api/') || pathname === '/account.html' || (method !== 'GET' && method !== 'HEAD')) {
        return json(res, 404, { error: 'Not found' });
      }
      if (webRoot && pathname === '/web') {
        res.writeHead(308, { Location: '/web/' }).end();
        return;
      }
      const isWeb = webRoot && pathname.startsWith('/web/');
      const staticRoot = isWeb ? webRoot : root;
      const resource = isWeb ? pathname.slice('/web'.length) : pathname;
      const file = path.resolve(staticRoot, '.' + (resource === '/' ? '/index.html' : resource));
      const type = mime[path.extname(file)];
      if (!file.startsWith(staticRoot + path.sep) || !type) return json(res, 404, { error: 'Not found' });
      const body = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      });
      res.end(method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (error instanceof URIError) return json(res, 400, { error: 'Invalid URL' });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return json(res, 404, { error: 'Not found' });
      console.error('[Mobile] Request failed', code ?? '');
      return json(res, 500, { error: 'Server error' });
    }
  };
}
