import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { POSSIBLE_GROUPS, type ManagedSubscription, type ScheduleResponse } from '@poweron/shared';
import { createPwaPushService, parsePushRegistration, type PwaPushService } from './pwa-push';
import { parseAccountGroups, type Accounts } from './accounts';

type ScheduleSource = {
  read: () => ScheduleResponse;
  refresh: () => Promise<ScheduleResponse>;
};

type SiteOptions = {
  webDirectory?: string;
  adminDirectory?: string;
  accounts?: Accounts;
  telegram?: {
    list: () => ManagedSubscription[] | Promise<ManagedSubscription[]>;
    update: (id: string, groups: string[], watching: boolean) => Promise<boolean>;
    username?: () => string | undefined;
    legacyGroups?: (id: string) => string[];
    onLinked?: (id: string) => Promise<void>;
  };
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

export function createPwaHandler(directory: string, schedule: ScheduleSource, push?: PwaPushService, options: SiteOptions = {}) {
  const accounts = options.accounts;
  return async (req: IncomingMessage, res: ServerResponse) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return json(res, 400, { error: 'Invalid URL' });
    }

    try {
      if (pathname === '/api/auth-options' && req.method === 'GET') {
        return json(res, 200, accounts?.loginMethods ?? { email: false, google: false });
      }
      if (pathname.startsWith('/api/auth/')) {
        if (!accounts) return json(res, 503, { error: 'Accounts are unavailable' });
        return await accounts.handleAuth(req, res);
      }
      if (pathname === '/api/me' || pathname.startsWith('/api/me/')) {
        if (!accounts) return json(res, 503, { error: 'Accounts are unavailable' });
        const actor = await accounts.actor(req.headers);
        if (!actor) return json(res, 401, { error: 'Sign in required' });
        if (req.method !== 'GET' && req.headers.origin !== accounts.origin) return json(res, 403, { error: 'Invalid origin' });
        if (pathname === '/api/me' && req.method === 'GET') {
          return json(res, 200, { email: actor.email, role: actor.role, adminVerified: actor.adminVerified,
            groups: await accounts.groups(actor.id), telegramId: await accounts.telegramId(actor.id) });
        }
        if (pathname === '/api/me/groups' && req.method === 'PUT') {
          const groups = parseAccountGroups(await readJson(req).catch(() => undefined));
          if (!groups) return json(res, 400, { error: 'Invalid groups' });
          await accounts.replaceGroups(actor.id, groups);
          return json(res, 200, { groups });
        }
        if (pathname === '/api/me/telegram-link' && req.method === 'POST') {
          const username = options.telegram?.username?.();
          if (!username) return json(res, 503, { error: 'Telegram is unavailable' });
          if (await accounts.telegramId(actor.id)) return json(res, 409, { error: 'Telegram is already linked' });
          const token = await accounts.createLink(actor);
          return json(res, 200, { url: `https://t.me/${username}?start=link_${token}` });
        }
        if (pathname === '/api/me/telegram-link' && req.method === 'GET') {
          return json(res, 200, { telegramId: await accounts.pendingLink(actor) });
        }
        if (pathname === '/api/me/telegram-link/confirm' && req.method === 'POST') {
          const id = await readJson(req).catch(() => undefined);
          if (typeof id !== 'string' || !/^\d+$/.test(id)) return json(res, 400, { error: 'Invalid Telegram identity' });
          const chat = await accounts.confirmLink(actor, id, options.telegram?.legacyGroups ?? (() => []));
          if (!chat) return json(res, 409, { error: 'Invalid or already linked Telegram account' });
          await options.telegram?.onLinked?.(chat);
          return json(res, 200, { telegramId: id });
        }
      }
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
      if (pathname === '/api/push/subscription' && (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE')) {
        if (!push) return json(res, 503, { error: 'Push is unavailable' });
        const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!token) return json(res, 401, { error: 'Invalid device token' });
        if (accounts && req.method !== 'GET' && req.headers.origin !== accounts.origin) return json(res, 403, { error: 'Invalid origin' });
        const actor = await accounts?.actor(req.headers);
        if (req.method === 'GET') {
          const preferences = await push.preferences(token, actor?.id);
          return preferences ? json(res, 200, preferences) : json(res, 404, { error: 'Subscription not found' });
        }
        if (req.method === 'DELETE') {
          if (!await push.remove(token, actor?.id)) return json(res, 404, { error: 'Subscription not found' });
        } else {
          const registration = parsePushRegistration(await readJson(req).catch(() => undefined));
          if (!registration) return json(res, 400, { error: 'Invalid subscription or groups' });
          const saved = await push.save(token, registration.subscription, registration.groups, schedule.read().snapshot, actor?.id);
          if (!saved) return json(res, 404, { error: 'Subscription not found' });
        }
        res.writeHead(204).end();
        return;
      }
      if (pathname === '/api/admin/subscriptions') {
        if (!accounts || !options.telegram) return json(res, 404, { error: 'Admin API is disabled' });
        const actor = await accounts.actor(req.headers);
        if (!actor) return json(res, 401, { error: 'Sign in required' });
        if (actor.role !== 'admin' || !actor.adminVerified) return json(res, 403, { error: 'Admin MFA required' });
        if (req.method === 'GET') {
          return json(res, 200, [...await options.telegram.list(), ...await (push?.list() ?? [])]);
        }
        if (req.method === 'PATCH') {
          if (req.headers.origin !== accounts.origin) return json(res, 403, { error: 'Invalid origin' });
          const body = await readJson(req).catch(() => undefined);
          if (!body || typeof body !== 'object' || !('channel' in body) || !('id' in body)
            || !('groups' in body) || !('watching' in body) || typeof body.id !== 'string'
            || typeof body.watching !== 'boolean' || !Array.isArray(body.groups)
            || body.groups.length > POSSIBLE_GROUPS.length
            || !body.groups.every((group) => typeof group === 'string' && POSSIBLE_GROUPS.includes(group))) {
            return json(res, 400, { error: 'Invalid subscription' });
          }
          const groups: string[] = [...new Set(body.groups)];
          let found = false;
          if (body.channel === 'telegram' && /^-?\d+$/.test(body.id)) {
            found = await options.telegram.update(body.id, groups, body.watching);
          } else if (body.channel === 'push' && /^[a-f0-9]{64}$/.test(body.id) && groups.length && push) {
            found = await push.update(body.id, groups, body.watching, schedule.read().snapshot);
          } else {
            return json(res, 400, { error: 'Invalid channel, subscription ID, or groups' });
          }
          if (!found) return json(res, 404, { error: 'Subscription not found' });
          await accounts.audit(actor, `${body.channel}:${body.id}`, { groups, watching: body.watching });
          res.writeHead(204).end();
          return;
        }
      }
      if (pathname.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) {
        return json(res, 404, { error: 'Not found' });
      }

      const site = ([['/web', options.webDirectory], ['/admin', options.adminDirectory]] as const)
        .find(([prefix, dir]) => dir && (pathname === prefix || pathname.startsWith(prefix + '/')));
      if (site && pathname === site[0]) {
        res.writeHead(308, { Location: site[0] + '/' }).end();
        return;
      }
      const root = site?.[1] ?? directory;
      const resource = site ? pathname.slice(site[0].length) : pathname;
      const file = path.resolve(root, `.${resource === '/' ? '/index.html' : resource}`);
      const type = mime[path.extname(file)];
      if (!file.startsWith(root + path.sep) || !type) return json(res, 404, { error: 'Not found' });
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

export async function startPwaServer(directory: string, schedule: ScheduleSource, options: SiteOptions = {}) {
  const port = Number(process.env.PWA_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PWA_PORT must be a valid port');
  await fs.access(path.join(directory, 'index.html'));
  const push = await createPwaPushService(options.accounts);
  const host = process.env.PWA_HOST ?? '127.0.0.1';
  const server = createServer(createPwaHandler(directory, schedule, push, options));
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
