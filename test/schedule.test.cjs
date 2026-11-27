const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const schedule = require('../dist/schedule.js');

const compiledBot = fs.readFileSync(require.resolve('../dist/index.js'), 'utf8');
const startTime = Date.parse('2026-11-27T20:30:00Z');
const tenMinutes = schedule.REFRESH_INTERVAL_MS;

function menu(today, tomorrow) {
  const menuItems = [{ name: 'Today', rawMobileHtml: today }];
  if (tomorrow !== undefined) menuItems.push({ name: 'Tomorrow', rawMobileHtml: tomorrow });
  return [{ menuItems }];
}

function html(first, second = 'Є електроенергія.') {
  return `<h2>Графік погодинних відключень</h2><p>Група 1,1. ${first}</p><p>Група 1.2. ${second}</p>`;
}

function createBot(users, initialFile = JSON.stringify({ users })) {
  let now = startTime;
  let disk = initialFile;
  let pendingWrite;
  let calls = 0;
  let loadMenu = async () => menu(html('Електроенергії немає з 12:00 до 13:00.'), html('Є електроенергія.'));
  const commands = {};
  const alerts = [];
  const logs = [];
  const startupErrors = [];
  const exits = [];
  const log = (message) => logs.push(message);
  const timers = [];
  const mockFs = {
    readFile: async () => {
      if (disk instanceof Error) throw disk;
      return disk;
    },
    writeFile: async (_file, content) => { pendingWrite = content; },
    rename: async () => { disk = pendingWrite; },
    rm: async () => {},
  };
  class MockTelegraf {
    telegram = {
      sendMessage: async (chatId, message) => { alerts.push({ chatId, message }); },
      setMyCommands: async () => {},
      deleteWebhook: async () => {},
    };
    start(handler) { commands.start = handler; }
    command(name, handler) { commands[name] = handler; }
    on(name, handler) { commands[name] = handler; }
    async launch() {}
  }
  vm.runInNewContext(compiledBot, {
    Date: class extends Date { static now() { return now; } },
    console: { log() {}, info: log, error: (...args) => startupErrors.push(args.join(' ')) },
    exports: {},
    require(name) {
      if (name === 'telegraf') return { Telegraf: MockTelegraf };
      if (name === 'node:fs/promises') return mockFs;
      if (name === './schedule') return {
        ...schedule,
        createScheduleFeed: () => schedule.createScheduleFeed(async () => {
          calls++;
          return schedule.parseScheduleFeed(await loadMenu(), now);
        }, () => now, log),
      };
      return require(name);
    },
    process: { env: { BOT_TOKEN: 'test' }, cwd: () => '.', pid: 1, loadEnvFile() {}, once() {}, exit: (code) => exits.push(code) },
    setTimeout(callback) { timers.push(callback); },
  });

  const flush = () => new Promise(setImmediate);
  return {
    alerts,
    logs,
    startupErrors,
    exits,
    get calls() { return calls; },
    get saved() { return JSON.parse(disk); },
    get disk() { return disk; },
    replaceState(content) { disk = content; },
    advance(ms) { now += ms; },
    useMenu(replacement) { loadMenu = replacement; },
    flush,
    async runScheduledPass() {
      await flush();
      assert.ok(timers.length, 'the bot scheduled a pass');
      timers.shift()();
      await flush();
    },
    async command(name, chatId, userId = chatId, text = '') {
      await flush();
      const replies = [];
      await commands[name]({
        chat: { id: chatId },
        from: { id: userId },
        message: { text },
        reply: async (message) => replies.push(message),
      });
      return replies.join('\n');
    },
  };
}

function watching() {
  return { watching: true, groups: ['1.1'] };
}

test('parses adjacent blocks and comma IDs, and falls back to readable desktop HTML', () => {
  const data = {
    'hydra:member': [{
      menuItems: [{
        name: 'Today',
        rawMobileHtml: '<p>Unreadable</p>',
        rawHtml: '<h2>Графік на 27.11.2026</h2><p>Група 1,1.<br>Перша</p><p>Група 1.2. Друга</p>',
        imageUrl: '/schedules/power.png',
      }],
    }],
  };
  const { today, tomorrow } = schedule.parseScheduleFeed(data, startTime);
  assert.equal(today.date, '2026-11-27');
  assert.deepEqual(today.headers, ['Графік на 27.11.2026']);
  assert.deepEqual(today.groups, { '1.1': 'Перша', '1.2': 'Друга' });
  assert.match(today.imageUrl, /^https:\/\/api\.loe\.lviv\.ua\//);
  assert.equal(tomorrow, undefined);
});

test('one upstream fetch for 100 chats, no duplicates, and only selected groups trigger changes', async () => {
  const bot = createBot(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i + 1, watching()])));
  await bot.runScheduledPass();
  assert.equal(bot.calls, 1);
  assert.deepEqual(bot.logs.filter((line) => line.startsWith('[LOE]')).slice(0, 3), [
    '[LOE] Scheduled check for 100 subscribed chats',
    '[LOE] Upstream fetch #1 started (scheduled) at 2026-11-27T20:30:00.000Z',
    '[LOE] Upstream fetch #1 succeeded in 0ms',
  ]);
  assert.equal(bot.alerts.length, 100);
  assert.ok(bot.alerts.every(({ message }) => message.includes('Зʼявився графік')));

  await bot.runScheduledPass();
  assert.equal(bot.calls, 1);
  assert.equal(bot.logs.filter((line) => line.includes('started')).length, 1);
  assert.match(bot.logs.at(-1), /skipped upstream fetch after fetch #1 \(using cached schedule/);
  assert.equal(bot.alerts.length, 100);

  bot.advance(tenMinutes);
  bot.useMenu(async () => menu(html('Електроенергії немає з 12:00 до 13:00.', 'Змінилася інша група.'), html('Є електроенергія.')));
  await bot.runScheduledPass();
  assert.equal(bot.calls, 2);
  assert.equal(bot.alerts.length, 100);

  bot.advance(tenMinutes);
  bot.useMenu(async () => menu(html('Електроенергії немає з 14:00 до 15:00.'), html('Є електроенергія.')));
  await bot.runScheduledPass();
  assert.equal(bot.calls, 3);
  assert.equal(bot.alerts.length, 200);
  assert.ok(bot.alerts.slice(100).every(({ message }) => message.includes('14:00')));
});

test('the same group text on the next Kyiv calendar date publishes a new daily alert', async () => {
  const bot = createBot({ 1: watching() });
  bot.advance(85 * 60 * 1000);
  bot.useMenu(async () => menu(html('Однаковий графік.')));
  await bot.runScheduledPass();
  assert.equal(bot.alerts.length, 0);

  bot.advance(tenMinutes); // Kyiv changes date while UTC still has the previous date.
  await bot.runScheduledPass();
  assert.equal(bot.alerts.length, 1);
  assert.match(bot.alerts[0].message, /на сьогодні! \(28\.11\.2026\)/);
});

test('onboarding uses the cached baseline to send the next relevant change', async () => {
  const bot = createBot({ 1: watching() });
  bot.useMenu(async () => menu(html('Початковий графік.')));
  await bot.runScheduledPass();

  await bot.command('start', 2);
  assert.match(await bot.command('text', 2, 2, '1,2'), /Є електроенергія/);
  assert.equal(bot.calls, 1);
  bot.advance(tenMinutes);
  bot.useMenu(async () => menu(html('Початковий графік.', 'Змінився графік для 1.2.')));
  await bot.runScheduledPass();
  assert.deepEqual(bot.alerts.map(({ chatId }) => chatId), ['2']);
});

test('all users and scheduled checks share one in-flight fetch and one cooldown', async () => {
  const bot = createBot({ 1: watching(), 2: watching() });
  let resolve;
  bot.useMenu(() => new Promise((next) => { resolve = next; }));
  const first = bot.command('check', 1, 10);
  const other = bot.command('check', 2, 20);
  await bot.runScheduledPass();
  assert.equal(bot.calls, 1);
  assert.ok(bot.logs.some((line) => line.endsWith('joined in-flight fetch #1')));
  resolve(menu(html('Є електроенергія.')));
  const firstReply = await first;
  assert.match(firstReply, /Наступний запит до API можливий з/);
  assert.match(firstReply, /Є електроенергія/);
  assert.equal(await other, firstReply);

  bot.useMenu(async () => menu(html('Новий графік.')));
  bot.advance(3 * 60 * 1000);
  assert.equal(await bot.command('check', 2, 30), firstReply);
  assert.equal(await bot.command('check', 1, 10), firstReply);
  assert.equal(bot.calls, 1);

  bot.advance(7 * 60 * 1000);
  assert.match(await bot.command('schedule', 1), /Є електроенергія/);
  assert.equal(bot.calls, 1);
  const nextReply = await bot.command('check', 1, 30);
  assert.match(nextReply, /Новий графік/);
  assert.equal(await bot.command('check', 2, 10), nextReply);
  assert.equal(bot.calls, 2);
});

test('a slow fetch stays shared for ten minutes after it completes', async () => {
  let now = startTime;
  let calls = 0;
  let finish;
  const feed = schedule.createScheduleFeed(() => {
    calls++;
    if (calls > 1) return Promise.resolve({ fetchedAt: now });
    return new Promise((resolve) => { finish = resolve; });
  }, () => now, () => {});

  const initial = feed.refresh('scheduled');
  await Promise.resolve();
  now += 15_000;
  finish({ fetchedAt: now });
  await initial;
  now = startTime + tenMinutes;
  await feed.refresh('manual');
  assert.equal(calls, 1);
  now += 15_000;
  await feed.refresh('manual');
  assert.equal(calls, 2);
});

test('malformed and failed upstream responses retain the last good data and respect the global limit', async () => {
  const bot = createBot({ 1: watching() });
  await bot.runScheduledPass();
  bot.advance(tenMinutes);
  bot.useMenu(async () => menu('<p>Unreadable schedule</p>'));
  const malformed = await bot.command('check', 1);
  assert.match(malformed, /Не вдалося оновити графік/);
  assert.match(malformed, /12:00/);
  assert.equal(bot.alerts.length, 1);

  bot.useMenu(async () => { throw new Error('network failure'); });
  bot.advance(tenMinutes);
  const failed = await bot.command('check', 1);
  assert.match(failed, /12:00/);
  assert.match(failed, /Не вдалося оновити графік/);
  await bot.runScheduledPass();
  assert.equal(bot.calls, 3);
  assert.equal(bot.alerts.length, 1);
});

test('old user cooldowns are ignored and dropped on the next state save', async () => {
  const oldState = JSON.stringify({ users: { 1: watching() }, nextManualRefreshByUser: { 10: startTime + tenMinutes } });
  const bot = createBot({}, oldState);
  await bot.command('check', 1, 10);
  assert.equal(bot.calls, 1);
  assert.equal(bot.saved.nextManualRefreshByUser, undefined);
});

test('startup keeps all users when the saved JSON has a UTF-8 BOM', async () => {
  const bot = createBot({}, '\uFEFF' + JSON.stringify({ users: { 1: watching(), 2: watching(), 3: watching() } }));
  await bot.runScheduledPass();
  assert.deepEqual(Object.keys(bot.saved.users), ['1', '2', '3']);
  assert.ok(bot.logs.some((line) => line.startsWith('[State] Loaded 3 chat records')));
});

test('startup recovers misplaced root-level chats and prefers records already inside users', async () => {
  const original = JSON.stringify({
    users: { 1: watching() },
    1: { groups: ['1.2'], watching: false },
    2: watching(),
  });
  const bot = createBot({}, original);
  await bot.runScheduledPass();
  assert.deepEqual(Object.keys(bot.saved.users), ['1', '2']);
  assert.deepEqual(bot.saved.users[1].groups, ['1.1']);
  assert.equal(bot.saved[2], undefined);
});

test('startup exits on malformed or unreadable state instead of opening an empty user list', async () => {
  for (const file of ['{invalid', '{"users":[]}', Object.assign(new Error('access denied'), { code: 'EACCES' })]) {
    const bot = createBot({}, file);
    await bot.flush();
    assert.deepEqual(bot.exits, [1]);
    assert.match(bot.startupErrors[0], /Fatal startup error/);
    assert.equal(bot.calls, 0);
    assert.equal(bot.disk, file);
  }
});

test('a bot with stale in-memory state refuses to overwrite a changed file', async () => {
  const bot = createBot({ 1: watching() });
  await bot.flush();
  const updated = JSON.stringify({ users: { 1: watching(), 2: watching() } });
  bot.replaceState(updated);
  await assert.rejects(bot.command('start', 3), /Bot state changed on disk/);
  assert.equal(bot.disk, updated);
});
