const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createPwaHandler } = require('../dist/pwa.js');
const { comparePushSchedule, parsePushRegistration } = require('../dist/pwa-push.js');
const { createScheduleFeed } = require('../dist/schedule.js');

const now = Date.parse('2026-11-27T20:30:00Z');
const day = (date, groups) => ({ date, groups, headers: [], imageUrl: '' });
const snapshot = {
  fetchedAt: now,
  today: day('2026-11-27', { '1.1': 'Power on', '1.2': 'Power off' }),
};
const registration = {
  groups: ['1.1'],
  subscription: {
    endpoint: 'https://web.push.apple.com/example',
    keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) },
  },
};
const token = 'a'.repeat(64);

async function send(handler, url, method = 'GET', body, headers = {}) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url, headers,
  });
  const response = {
    writeHead(code) { this.status = code; return this; },
    end(payload) { this.body = payload === undefined ? undefined : JSON.parse(payload); },
  };
  await handler(request, response);
  return { status: response.status, body: response.body };
}

test('PWA reads the existing cache and manual refresh shares an upstream fetch with the bot', async () => {
  let calls = 0;
  const feed = createScheduleFeed(async () => { calls++; return snapshot; }, () => now, () => {});
  const result = () => ({ snapshot: feed.read().snapshot, nextFetchAt: feed.nextFetchAt(), refreshFailed: false });
  const handler = createPwaHandler(path.resolve('unused'), {
    read: result,
    refresh: async () => { await feed.refresh('manual'); return result(); },
  });
  assert.equal((await send(handler, '/api/schedule')).body.snapshot, undefined);
  assert.equal(calls, 0);
  const [response] = await Promise.all([
    send(handler, '/api/schedule/refresh', 'POST', {}, { 'content-type': 'application/json' }),
    feed.refresh('scheduled'),
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.snapshot, snapshot);
  assert.equal(calls, 1);
  assert.deepEqual((await send(handler, '/api/schedule')).body, response.body);
});

test('the account page can discover enabled sign-in methods without a session', async () => {
  const root = path.resolve('unused');
  const feed = { read: () => ({ snapshot }) };
  const defaults = createPwaHandler(root, feed);
  assert.deepEqual(await send(defaults, '/api/auth-options'), {
    status: 200, body: { email: false, google: false },
  });
  const configured = createPwaHandler(root, feed, undefined, {
    accounts: { loginMethods: { email: false, google: true } },
  });
  assert.deepEqual(await send(configured, '/api/auth-options'), {
    status: 200, body: { email: false, google: true },
  });
});

test('Web Push alerts reflect only selected groups and do not repeat after applying the snapshot', () => {
  const initial = comparePushSchedule(snapshot, ['1.1']);
  assert.deepEqual(initial.alerts, []);
  const changedUnwatched = {
    ...snapshot, today: day('2026-11-27', { '1.1': 'Power on', '1.2': 'Changed' }),
  };
  assert.deepEqual(comparePushSchedule(changedUnwatched, ['1.1'], initial.baseline).alerts, []);
  const changed = {
    ...snapshot, today: day('2026-11-27', { '1.1': 'Changed' }),
    tomorrow: day('2026-11-28', { '1.1': 'Newly published' }),
  };
  const next = comparePushSchedule(changed, ['1.1'], initial.baseline);
  assert.equal(next.alerts.length, 2);
  assert.deepEqual(comparePushSchedule(changed, ['1.1'], next.baseline).alerts, []);
});

test('push registrations require a device token, known group and supported HTTPS endpoint', async () => {
  assert.deepEqual(parsePushRegistration(registration), registration);
  for (const endpoint of ['http://fcm.googleapis.com/push', 'https://127.0.0.1/push', 'https://web.push.apple.com.example.test/push']) {
    assert.equal(parsePushRegistration({ ...registration, subscription: { ...registration.subscription, endpoint } }), undefined);
  }
  const calls = [];
  const push = {
    publicKey: 'public',
    async save(...args) { calls.push(args.slice(0, 4)); return true; },
    async remove(value) { calls.push(value); return true; },
  };
  const handler = createPwaHandler(path.resolve('unused'), { read: () => ({ snapshot }) }, push);
  assert.equal((await send(handler, '/api/push/subscription', 'PUT', registration)).status, 401);
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  assert.equal((await send(handler, '/api/push/subscription', 'PUT', { ...registration, groups: ['9.9'] }, headers)).status, 400);
  assert.equal((await send(handler, '/api/push/subscription', 'PUT', registration, headers)).status, 204);
  assert.deepEqual(calls[0], [token, registration.subscription, registration.groups, snapshot]);
  assert.equal((await send(handler, '/api/push/subscription', 'DELETE', undefined, headers)).status, 204);
  assert.equal(calls[1], token);
});

test('admin authentication protects both subscription channels and their updates', async () => {
  const changes = [];
  const telegramRow = { id: '123', channel: 'telegram', groups: ['1.1'], watching: true };
  const pushRow = { ...telegramRow, id: 'b'.repeat(64), channel: 'push' };
  const handler = createPwaHandler(path.resolve('unused'), { read: () => ({ snapshot }) }, {
    list: async () => [pushRow],
    update: async (...args) => { changes.push(args); return true; },
  }, {
    accounts: {
      origin: 'https://poweron.example',
      actor: async (headers) => {
        if (!headers.cookie) return;
        return { id: 'admin-id', role: 'admin', adminVerified: headers.cookie === 'mfa' };
      },
      audit: async () => {},
    },
    telegram: {
      list: () => [telegramRow],
      update: async (...args) => { changes.push(args); return true; },
    },
  });
  const url = '/api/admin/subscriptions';
  const admin = { cookie: 'mfa', origin: 'https://poweron.example', 'content-type': 'application/json' };
  assert.equal((await send(handler, url)).status, 401);
  assert.equal((await send(handler, url, 'PATCH', telegramRow)).status, 401);
  assert.equal((await send(handler, url, 'GET', undefined, { cookie: 'password-only' })).status, 403);
  assert.equal((await send(handler, url, 'PATCH', telegramRow, { ...admin, origin: 'https://other.example' })).status, 403);
  assert.deepEqual((await send(handler, url, 'GET', undefined, admin)).body, [telegramRow, pushRow]);
  assert.equal((await send(handler, url, 'PATCH', { ...telegramRow, groups: ['9.9'] }, admin)).status, 400);
  assert.equal((await send(handler, url, 'PATCH', { ...telegramRow, watching: false }, admin)).status, 204);
  assert.equal((await send(handler, url, 'PATCH', { ...pushRow, groups: ['1.2'] }, admin)).status, 204);
  assert.deepEqual(changes, [
    [telegramRow.id, ['1.1'], false],
    [pushRow.id, ['1.2'], true, snapshot],
  ]);
});

test('account groups are resolved from the session instead of an ID supplied by the browser', async () => {
  const changes = [];
  const accounts = {
    origin: 'https://poweron.example',
    actor: async (headers) => headers.cookie && { id: 'owner', email: 'owner@example.com' },
    groups: async (id) => id === 'owner' ? ['1.1'] : [],
    telegramId: async () => undefined,
    replaceGroups: async (...args) => { changes.push(args); },
  };
  const handler = createPwaHandler(path.resolve('unused'), { read: () => ({}) }, undefined, { accounts });
  const origin = { origin: accounts.origin, cookie: 'auth', 'content-type': 'application/json' };
  assert.equal((await send(handler, '/api/me')).status, 401);
  assert.deepEqual((await send(handler, '/api/me?userId=someone-else', 'GET', undefined, origin)).body.groups, ['1.1']);
  assert.equal((await send(handler, '/api/me/groups', 'PUT', ['1.2'], { ...origin, origin: 'https://other.example' })).status, 403);
  assert.equal((await send(handler, '/api/me/groups', 'PUT', ['9.9'], origin)).status, 400);
  assert.equal((await send(handler, '/api/me/groups?userId=someone-else', 'PUT', ['1.2'], origin)).status, 200);
  assert.deepEqual(changes, [['owner', ['1.2']]]);
});

test('a restarted feed serves the saved snapshot until its shared cooldown expires', async () => {
  let calls = 0;
  let time = now;
  const feed = createScheduleFeed(async () => { calls++; return snapshot; }, () => time, () => {});
  feed.restore(snapshot, time + 60_000);
  assert.equal((await feed.refresh('manual')).snapshot, snapshot);
  assert.equal(calls, 0);
  time += 60_000;
  await feed.refresh('scheduled');
  assert.equal(calls, 1);
});
