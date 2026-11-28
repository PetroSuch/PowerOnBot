import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Pool, type PoolClient } from 'pg';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { twoFactor } from 'better-auth/plugins';
import { POSSIBLE_GROUPS } from '@poweron/shared';

const digest = (token: string) => createHash('sha256').update(token).digest();
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const accountSchema = `
  CREATE TABLE IF NOT EXISTS poweron_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_subject text UNIQUE NOT NULL,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    groups_initialized boolean NOT NULL DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS poweron_user_groups (
    user_id uuid NOT NULL REFERENCES poweron_users ON DELETE CASCADE,
    group_id text NOT NULL CHECK (group_id ~ '^[1-6][.][12]$'),
    PRIMARY KEY (user_id, group_id)
  );
  CREATE TABLE IF NOT EXISTS poweron_telegram_links (
    telegram_user_id text PRIMARY KEY,
    chat_id text UNIQUE NOT NULL,
    user_id uuid UNIQUE NOT NULL REFERENCES poweron_users ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS poweron_telegram_challenges (
    session_id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES poweron_users ON DELETE CASCADE,
    code_hash bytea UNIQUE NOT NULL,
    expires_at timestamptz NOT NULL,
    telegram_user_id text,
    chat_id text
  );
  CREATE TABLE IF NOT EXISTS poweron_admin_mfa (
    session_id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES poweron_users ON DELETE CASCADE,
    verified_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS poweron_admin_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id uuid NOT NULL REFERENCES poweron_users,
    action text NOT NULL,
    target text NOT NULL,
    changes jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

export function parseAccountGroups(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > POSSIBLE_GROUPS.length
    || !value.every((group) => typeof group === 'string' && POSSIBLE_GROUPS.includes(group))) return;
  return POSSIBLE_GROUPS.filter((group) => value.includes(group));
}

type User = { id: string; role: 'user' | 'admin' };
type Actor = User & { email: string; sessionId: string; adminVerified: boolean };
type AccountOptions = {
  databaseUrl: string;
  directUrl?: string;
  origin: string;
  secret: string;
  sendMail?: (to: string, subject: string, message: string) => Promise<void>;
  google?: { clientId: string; clientSecret: string };
};

export async function openAccounts(options: AccountOptions) {
  const { databaseUrl, directUrl, origin, secret, sendMail, google } = options;
  const db = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 8000 });
  db.on('error', () => console.error('[Accounts] PostgreSQL pool error'));
  const mail = (to: string, subject: string, text: string) => {
    void sendMail?.(to, subject, text).catch(() => console.error('[Accounts] Could not send an account email'));
  };

  const auth = betterAuth({
    appName: 'PowerOn',
    baseURL: origin,
    secret,
    database: db,
    user: { modelName: 'poweron_auth_user' },
    session: { modelName: 'poweron_auth_session', cookieCache: { enabled: false } },
    account: {
      modelName: 'poweron_auth_account',
      encryptOAuthTokens: true,
      accountLinking: { disableImplicitLinking: true, allowDifferentEmails: false },
    },
    verification: { modelName: 'poweron_auth_verification' },
    socialProviders: google ? { google: { ...google, prompt: 'select_account' } } : {},
    emailAndPassword: {
      enabled: !!sendMail, minPasswordLength: 12, requireEmailVerification: true, revokeSessionsOnPasswordReset: true,
      sendResetPassword: sendMail ? async ({ user, url }) => mail(user.email, 'PowerOn — відновлення пароля', url) : undefined,
    },
    emailVerification: sendMail ? {
      sendOnSignUp: true, sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => mail(user.email, 'PowerOn — підтвердження адреси', url),
    } : undefined,
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      useSecureCookies: new URL(origin).protocol === 'https:',
      ipAddress: { ipAddressHeaders: ['x-poweron-peer-ip'] },
    },
    plugins: [twoFactor({ issuer: 'PowerOn' })],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const session = ctx.context.newSession;
        if (ctx.path !== '/two-factor/verify-totp' || !session) return;
        await db.query(`
          INSERT INTO poweron_admin_mfa (session_id, user_id)
          SELECT $1, id FROM poweron_users WHERE auth_subject = $2 AND role = 'admin'
          ON CONFLICT (session_id) DO UPDATE SET verified_at = now()
        `, [session.session.id, session.user.id]);
      }),
    },
  });

  const migrationPool = directUrl ? new Pool({ connectionString: directUrl }) : db;
  try {
    await migrationPool.query(accountSchema);
    const migration = await getMigrations({ ...auth.options, database: migrationPool });
    await migration.runMigrations();
    await db.query("DELETE FROM poweron_admin_mfa WHERE verified_at < now() - interval '1 day'");
  } catch (error) {
    await db.end();
    throw error;
  } finally {
    if (migrationPool !== db) await migrationPool.end();
  }

  async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function putGroups(client: PoolClient, userId: string, groups: string[]) {
    await client.query('UPDATE poweron_users SET groups_initialized = true WHERE id = $1', [userId]);
    await client.query('DELETE FROM poweron_user_groups WHERE user_id = $1', [userId]);
    await client.query('INSERT INTO poweron_user_groups SELECT $1, unnest($2::text[])', [userId, groups]);
  }

  const sendAuth = toNodeHandler(auth);
  return {
    origin,
    loginMethods: { email: !!sendMail, google: !!google },
    handleAuth(req: IncomingMessage, res: ServerResponse) {
      req.headers['x-poweron-peer-ip'] = req.socket.remoteAddress;
      return sendAuth(req, res);
    },
    async actor(headers: IncomingHttpHeaders): Promise<Actor | undefined> {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
      if (!session?.user.emailVerified) return;
      const readUser = () => db.query<User>('SELECT id, role FROM poweron_users WHERE auth_subject = $1', [session.user.id]);
      let user = (await readUser()).rows[0];
      if (!user) {
        await db.query('INSERT INTO poweron_users (auth_subject) VALUES ($1) ON CONFLICT DO NOTHING', [session.user.id]);
        user = (await readUser()).rows[0];
      }
      const sessionId = session.session.id;
      const mfa = user.role === 'admin' && session.user.twoFactorEnabled && (await db.query(`
        SELECT 1 FROM poweron_admin_mfa WHERE session_id = $1 AND user_id = $2
          AND verified_at > now() - interval '12 hours'
      `, [sessionId, user.id])).rowCount === 1;
      return { ...user, email: session.user.email, sessionId, adminVerified: !!mfa };
    },
    async grantAdmin(email: string) {
      if (!sendMail) return false;
      const result = await db.query(`
        INSERT INTO poweron_users (auth_subject, role)
        SELECT u.id, 'admin' FROM poweron_auth_user u
        WHERE lower(u.email) = lower($1) AND u."emailVerified"
          AND EXISTS (
            SELECT 1 FROM poweron_auth_account a
            WHERE a."userId" = u.id AND a."providerId" = 'credential' AND a.password IS NOT NULL
          )
        ON CONFLICT (auth_subject) DO UPDATE SET role = 'admin'
      `, [email]);
      return result.rowCount === 1;
    },
    async audit(actor: Actor, target: string, changes: unknown) {
      await db.query(`INSERT INTO poweron_admin_audit (actor_id, action, target, changes)
        VALUES ($1, 'subscription.updated', $2, $3)`, [actor.id, target, JSON.stringify(changes)]);
    },
    async groups(userId: string) {
      const result = await db.query<{ group_id: string }>(
        'SELECT group_id FROM poweron_user_groups WHERE user_id = $1 ORDER BY group_id', [userId],
      );
      return result.rows.map((row) => row.group_id);
    },
    replaceGroups(userId: string, groups: string[]) {
      return transaction((client) => putGroups(client, userId, groups));
    },
    importGroups(userId: string, groups: string[]) {
      return transaction(async (client) => {
        const row = await client.query<{ groups_initialized: boolean }>(
          'SELECT groups_initialized FROM poweron_users WHERE id = $1 FOR UPDATE', [userId],
        );
        if (!row.rows[0].groups_initialized && groups.length) await putGroups(client, userId, groups);
      });
    },
    async linkedChats() {
      const result = await db.query<{ chat_id: string; user_id: string; groups: string[] }>(`
        SELECT link.chat_id, link.user_id,
          ARRAY(SELECT group_id FROM poweron_user_groups WHERE user_id = link.user_id ORDER BY group_id) AS groups
        FROM poweron_telegram_links link
      `);
      return result.rows;
    },
    async linkedChat(chatId: string) {
      const result = await db.query<{ user_id: string; groups: string[] }>(`
        SELECT link.user_id,
          ARRAY(SELECT group_id FROM poweron_user_groups WHERE user_id = link.user_id ORDER BY group_id) AS groups
        FROM poweron_telegram_links link WHERE link.chat_id = $1
      `, [chatId]);
      return result.rows[0];
    },
    async telegramId(userId: string) {
      const result = await db.query<{ telegram_user_id: string }>(
        'SELECT telegram_user_id FROM poweron_telegram_links WHERE user_id = $1', [userId],
      );
      return result.rows[0]?.telegram_user_id;
    },
    async createLink(actor: Actor) {
      const token = randomBytes(32).toString('base64url');
      await db.query('DELETE FROM poweron_telegram_challenges WHERE expires_at <= now()');
      await db.query(`
        INSERT INTO poweron_telegram_challenges (session_id, user_id, code_hash, expires_at)
        VALUES ($1, $2, $3, now() + interval '5 minutes')
        ON CONFLICT (session_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
          telegram_user_id = NULL, chat_id = NULL, user_id = EXCLUDED.user_id
      `, [actor.sessionId, actor.id, digest(token)]);
      return token;
    },
    async receiveLink(token: string, telegramId: string, chatId: string) {
      if (!tokenPattern.test(token)) return false;
      const result = await db.query(`
        UPDATE poweron_telegram_challenges SET telegram_user_id = $2, chat_id = $3
        WHERE code_hash = $1 AND expires_at > now() AND telegram_user_id IS NULL
      `, [digest(token), telegramId, chatId]);
      return result.rowCount === 1;
    },
    async pendingLink(actor: Actor) {
      const result = await db.query<{ telegram_user_id: string | null }>(`
        SELECT telegram_user_id FROM poweron_telegram_challenges
        WHERE session_id = $1 AND user_id = $2 AND expires_at > now()
      `, [actor.sessionId, actor.id]);
      return result.rows[0]?.telegram_user_id ?? null;
    },
    async confirmLink(actor: Actor, telegramId: string, legacyGroups: (chatId: string) => string[]) {
      return transaction(async (client) => {
        const pending = await client.query<{ chat_id: string }>(`
          DELETE FROM poweron_telegram_challenges
          WHERE session_id = $1 AND user_id = $2 AND telegram_user_id = $3 AND expires_at > now() RETURNING chat_id
        `, [actor.sessionId, actor.id, telegramId]);
        const chat = pending.rows[0]?.chat_id;
        if (!chat) return undefined;
        const linked = await client.query(`
          INSERT INTO poweron_telegram_links (telegram_user_id, chat_id, user_id) VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `, [telegramId, chat, actor.id]);
        if (!linked.rowCount) return undefined;
        const flags = await client.query<{ groups_initialized: boolean }>(
          'SELECT groups_initialized FROM poweron_users WHERE id = $1 FOR UPDATE', [actor.id],
        );
        if (!flags.rows[0].groups_initialized) {
          const groups = parseAccountGroups(legacyGroups(chat)) ?? [];
          if (groups.length) await putGroups(client, actor.id, groups);
        }
        return chat;
      });
    },
    close: () => db.end(),
  };
}

export type Accounts = Awaited<ReturnType<typeof openAccounts>>;

export function openConfiguredAccounts() {
  const {
    POWERON_AUTH_URL, BETTER_AUTH_SECRET, DATABASE_URL, DATABASE_URL_UNPOOLED,
    RESEND_API_KEY, AUTH_EMAIL_FROM, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  } = process.env;
  if (!POWERON_AUTH_URL && !BETTER_AUTH_SECRET) return undefined;
  if (!POWERON_AUTH_URL || !BETTER_AUTH_SECRET || BETTER_AUTH_SECRET.length < 32 || !DATABASE_URL) {
    throw new Error('Accounts require POWERON_AUTH_URL, BETTER_AUTH_SECRET (32+ chars), and DATABASE_URL');
  }
  if (!!GOOGLE_CLIENT_ID !== !!GOOGLE_CLIENT_SECRET) {
    throw new Error('Google sign-in requires both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  }
  if (!!RESEND_API_KEY !== !!AUTH_EMAIL_FROM) {
    throw new Error('Email sign-in requires both RESEND_API_KEY and AUTH_EMAIL_FROM');
  }
  const google = GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
    ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
    : undefined;
  if (!google && !RESEND_API_KEY) {
    throw new Error('Accounts require Google OAuth credentials or an email provider');
  }
  const origin = new URL(POWERON_AUTH_URL);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) {
    throw new Error('POWERON_AUTH_URL must use HTTPS outside localhost');
  }
  return openAccounts({
    databaseUrl: DATABASE_URL, directUrl: DATABASE_URL_UNPOOLED, origin: origin.origin, secret: BETTER_AUTH_SECRET,
    google,
    sendMail: RESEND_API_KEY ? async (to, subject, text) => {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: AUTH_EMAIL_FROM, to: [to], subject, text }),
      });
      if (!response.ok) throw new Error('Email delivery failed');
    } : undefined,
  });
}
