const get = (id) => document.getElementById(id);
const groups = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const params = new URLSearchParams(location.search);
const requestedReturn = params.get('return');
const returnPath = ['/', '/web/', '/admin/'].includes(requestedReturn) ? requestedReturn : '/';
const accountPath = '/account.html?return=' + encodeURIComponent(returnPath);
get('back').href = returnPath;
let loginMethods = { email: false, google: false };
let candidate;
const show = (text) => get('message').textContent = text;
const field = (form, name) => String(new FormData(form).get(name) ?? '');

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error('Request failed');
    error.status = response.status;
    error.code = (await response.json().catch(() => ({}))).code;
    throw error;
  }
  return response.json();
}
const auth = (path, body) => api('/api/auth/' + path, 'POST', body);
function bind(id, event, handler) {
  get(id).addEventListener(event, async (e) => {
    e.preventDefault();
    const control = e.submitter ?? (event === 'click' ? e.currentTarget : null);
    if (control?.disabled) return;
    if (control) control.disabled = true;
    show('');
    try { await handler(e); }
    catch (error) {
      show(error.code === 'EMAIL_NOT_VERIFIED' ? 'Підтвердьте email за посиланням у листі.'
        : 'Не вдалося виконати дію. Перевірте дані або повторіть спробу пізніше.');
    } finally { if (control) control.disabled = false; }
  });
}
async function profile() {
  let me;
  try { me = await api('/api/me'); }
  catch (error) {
    if (error.status === 503) show('Вхід тимчасово недоступний.');
    else if (error.status !== 401) throw error;
  }
  get('profile').hidden = !me;
  get('credentials').hidden = !!me || !loginMethods.email;
  get('google-sign-in').hidden = !!me || !loginMethods.google;
  get('google-link').hidden = !loginMethods.google;
  get('totp').hidden = true;
  if (!me) return;
  get('email').textContent = me.email;
  get('telegram-status').textContent = me.telegramId ? 'Під’єднано: ' + me.telegramId : 'Telegram ще не під’єднано.';
  get('connect').hidden = !!me.telegramId;
  get('check-link').hidden = !!me.telegramId;
  get('telegram-link').hidden = true;
  get('confirm-link').hidden = true;
  get('admin').hidden = me.role !== 'admin';
  get('admin-link').hidden = !me.adminVerified;
  get('groups').replaceChildren(...groups.map((group) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = group;
    checkbox.name = 'group';
    checkbox.checked = me.groups.includes(group);
    label.append(checkbox, ' ' + group);
    return label;
  }));
}
async function startGoogleSignIn(endpoint) {
  const { url } = await auth(endpoint, {
    provider: 'google',
    callbackURL: accountPath,
    errorCallbackURL: accountPath + '&google=1',
    disableRedirect: true,
  });
  const destination = new URL(url);
  if (destination.origin !== 'https://accounts.google.com') throw new Error('Unexpected Google sign-in URL');
  location.assign(destination.href);
}
bind('google-sign-in', 'click', () => startGoogleSignIn('sign-in/social'));
bind('google-link', 'click', () => startGoogleSignIn('link-social'));
bind('credentials', 'submit', async (e) => {
  const email = field(e.currentTarget, 'email').trim();
  const password = field(e.currentTarget, 'password');
  if (e.submitter?.value === 'register') {
    await auth('sign-up/email', { name: email, email, password, callbackURL: '/account.html' });
    show('Перевірте пошту й підтвердьте email.');
    return;
  }
  const result = await auth('sign-in/email', { email, password });
  e.currentTarget.reset();
  if (result.twoFactorRedirect) {
    get('credentials').hidden = true;
    get('google-sign-in').hidden = true;
    get('totp').hidden = false;
  } else await profile();
});
bind('forgot', 'click', async () => {
  const email = field(get('credentials'), 'email').trim();
  if (!email) { show('Введіть email.'); return; }
  await auth('request-password-reset', { email, redirectTo: location.origin + '/account.html' });
  show('Якщо така адреса зареєстрована, на неї надійде лист.');
});
if (params.has('token')) {
  get('credentials').hidden = true;
  get('reset').hidden = false;
  history.replaceState(null, '', '/account.html');
}
bind('reset', 'submit', async (e) => {
  await auth('reset-password', { token: params.get('token'), newPassword: field(e.currentTarget, 'password') });
  get('reset').hidden = true;
  await profile();
  show('Пароль змінено. Увійдіть знову.');
});
bind('groups-form', 'submit', async (e) => {
  await api('/api/me/groups', 'PUT', new FormData(e.currentTarget).getAll('group'));
  show('Групи збережено.');
});
bind('connect', 'click', async () => {
  const { url } = await api('/api/me/telegram-link', 'POST', {});
  get('telegram-link').href = url;
  get('telegram-link').hidden = false;
  get('confirm-link').hidden = true;
});
bind('check-link', 'click', async () => {
  const { telegramId } = await api('/api/me/telegram-link');
  candidate = telegramId;
  get('confirm-link').hidden = !candidate;
  show(candidate ? 'Підтверджуєте прив’язку Telegram ID ' + candidate + '?'
    : 'Відкрийте посилання й натисніть Start у боті.');
});
bind('confirm-link', 'click', async () => {
  await api('/api/me/telegram-link/confirm', 'POST', candidate);
  candidate = undefined;
  await profile();
  show('Telegram під’єднано.');
});
bind('enroll', 'submit', async (e) => {
  const result = await auth('two-factor/enable', { password: field(e.currentTarget, 'password') });
  e.currentTarget.reset();
  get('totp-secret').textContent = new URL(result.totpURI).searchParams.get('secret');
  get('backup-codes').textContent = result.backupCodes.join('\n');
  get('totp-setup').hidden = false;
  get('totp').hidden = false;
});
bind('totp', 'submit', async (e) => {
  await auth('two-factor/verify-totp', { code: field(e.currentTarget, 'code').trim() });
  e.currentTarget.reset();
  get('totp-setup').hidden = true;
  get('totp-secret').textContent = '';
  get('backup-codes').textContent = '';
  await profile();
});
bind('logout', 'click', async () => {
  await auth('sign-out', {});
  location.replace('/account.html');
});
async function loadAccount() {
  loginMethods = await api('/api/auth-options');
  if (params.has('token')) return;
  await profile();
  if (params.get('google') === '1' && params.has('error')) {
    show(loginMethods.email
      ? 'Не вдалося завершити вхід через Google. Якщо акаунт уже існує, увійдіть паролем і під’єднайте Google у профілі.'
      : 'Не вдалося завершити вхід через Google. Спробуйте ще раз.');
  }
}
void loadAccount().catch(() => show('Не вдалося завантажити акаунт.'));
