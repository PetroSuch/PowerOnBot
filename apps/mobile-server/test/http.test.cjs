const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const test = require('node:test');
const { createMobileHandler } = require('../dist/http');

test('mobile API keeps device preferences private and separate from push subscriptions', async (t) => {
  const profiles = new Map();
  const snapshot = { fetchedAt: 1 };
  const backend = createMobileHandler('.', {
    read: () => ({ snapshot }),
    refresh: async () => ({ snapshot }),
  }, {
    publicKey: 'test-public-key',
    async getDevice(token) { return profiles.get(token); },
    async saveDevice(token, profile, baseline) {
      assert.equal(baseline, snapshot);
      const device = { ...profile, notificationsEnabled: profiles.get(token)?.notificationsEnabled ?? false };
      profiles.set(token, device);
      return device;
    },
    async subscribe(token, subscription) {
      assert.equal(subscription.endpoint, 'https://fcm.googleapis.com/example');
      const device = profiles.get(token);
      if (!device?.groups.length) return false;
      device.notificationsEnabled = true;
      return true;
    },
    async unsubscribe(token) {
      const device = profiles.get(token);
      if (device) device.notificationsEnabled = false;
    },
  });
  const server = createServer(backend);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = 'http://127.0.0.1:' + server.address().port;
  const token = 'a'.repeat(64);
  const secondToken = 'b'.repeat(64);
  const request = (path, method, token, body) => fetch(origin + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
  });
  assert.equal((await request('/api/device', 'GET')).status, 401);
  assert.equal((await request('/api/device', 'GET', token)).status, 404);
  assert.equal((await request('/api/device', 'PUT', token, { name: null, groups: ['9.3'] })).status, 400);
  const created = await request('/api/device', 'PUT', token, { name: '  Test  ', groups: ['5.2', '5.2'] });
  assert.deepEqual(await created.json(), { name: 'Test', groups: ['5.2'], notificationsEnabled: false });
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/api/device', 'GET', secondToken)).status, 404);
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/example',
    keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) },
  };
  assert.equal((await request('/api/push/subscription', 'PUT', secondToken, subscription)).status, 409);
  assert.equal((await request('/api/push/subscription', 'PUT', token, subscription)).status, 204);
  assert.equal((await (await request('/api/device', 'GET', token)).json()).notificationsEnabled, true);
  assert.equal((await request('/api/push/subscription', 'DELETE', token)).status, 204);
  assert.deepEqual(await (await request('/api/device', 'GET', token)).json(),
    { name: 'Test', groups: ['5.2'], notificationsEnabled: false });
  assert.equal((await request('/api/auth/sign-in/social', 'POST', undefined, {})).status, 404);
});
