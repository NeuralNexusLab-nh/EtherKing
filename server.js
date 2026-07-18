'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const {
  compactTitle,
  hashPassword,
  hashToken,
  isAllowedOrigin,
  isValidEmail,
  normalizeDisplayName,
  normalizeEmail,
  parseCookies,
  randomToken,
  safeEqual,
  todayUtc,
  validatePassword,
  verifyPassword
} = require('./lib/security');
const { SseTextDecoder } = require('./lib/sse');

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'etherking_session';
const CSRF_COOKIE = 'etherking_csrf';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_PROVIDER_OUTPUT_BYTES = 2 * 1024 * 1024;

const MODEL_REGISTRY = Object.freeze({
  'deepseek-v4-flash': { provider: 'DeepSeek', group: 'C', limit: 80 },
  'deepseek-v4-pro': { provider: 'DeepSeek', group: 'D', limit: 60 },
  'gpt-4o': { provider: 'OpenAI', group: 'D', limit: 60 },
  'gpt-4.1': { provider: 'OpenAI', group: 'D', limit: 60 },
  'gpt-5-nano': { provider: 'OpenAI', group: 'B', limit: 200, flex: true },
  'gpt-4o-mini': { provider: 'OpenAI', group: 'B', limit: 200 },
  'gpt-4.1-nano': { provider: 'OpenAI', group: 'B', limit: 200 },
  'gpt-5-mini': { provider: 'OpenAI', group: 'B', limit: 200, flex: true },
  'gpt-5': { provider: 'OpenAI', group: 'D', limit: 60, flex: true },
  'gpt-5.1': { provider: 'OpenAI', group: 'D', limit: 60, flex: true },
  'gpt-5.2': { provider: 'OpenAI', group: 'D', limit: 60, flex: true },
  'o4-mini': { provider: 'OpenAI', group: 'B', limit: 200, flex: true },
  'gpt-5.4': { provider: 'OpenAI', group: 'D', limit: 60, flex: true },
  'gpt-5.4-nano': { provider: 'OpenAI', group: 'B', limit: 200, flex: true },
  'gpt-5.4-mini': { provider: 'OpenAI', group: 'B', limit: 200, flex: true }
});

function createPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false
  });
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name VARCHAR(60) NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      csrf_hash CHAR(64) NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS chats (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(80) NOT NULL DEFAULT 'New chat',
      model VARCHAR(80) NOT NULL DEFAULT 'gpt-5.4-mini',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chats_user_updated_idx ON chats(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS messages_chat_created_idx ON messages(chat_id, created_at, id);

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date DATE NOT NULL,
      group_name VARCHAR(8) NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, usage_date, group_name)
    );

    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      bucket_key CHAR(64) PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function cookieOptions(httpOnly) {
  return {
    httpOnly,
    secure: IS_PRODUCTION,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS
  };
}

function clearAuthCookies(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(true));
  res.clearCookie(CSRF_COOKIE, cookieOptions(false));
}

async function issueSession(db, res, userId) {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO sessions (token_hash, csrf_hash, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(sessionToken), hashToken(csrfToken), userId, expiresAt]
  );
  res.cookie(SESSION_COOKIE, sessionToken, cookieOptions(true));
  res.cookie(CSRF_COOKIE, csrfToken, cookieOptions(false));
}

async function readSession(pool, req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token || token.length > 256) return null;
  const result = await pool.query(
    `SELECT s.token_hash, s.csrf_hash, s.user_id, s.expires_at,
            u.email, u.display_name, u.password_hash, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hashToken(token)]
  );
  if (!result.rowCount) return null;
  const session = result.rows[0];
  pool.query(
    `UPDATE sessions SET last_seen_at = NOW()
      WHERE token_hash = $1 AND last_seen_at < NOW() - INTERVAL '15 minutes'`,
    [session.token_hash]
  ).catch(() => {});
  return session;
}

function publicUser(session) {
  return {
    id: session.user_id,
    email: session.email,
    displayName: session.display_name,
    createdAt: session.created_at
  };
}

async function checkAuthRateLimit(pool, req) {
  const bucketKey = hashToken(`auth:${req.ip || 'unknown'}`);
  const result = await pool.query(
    `INSERT INTO auth_rate_limits (bucket_key, window_started_at, attempt_count)
     VALUES ($1, NOW(), 1)
     ON CONFLICT (bucket_key) DO UPDATE SET
       attempt_count = CASE
         WHEN auth_rate_limits.window_started_at < NOW() - INTERVAL '15 minutes' THEN 1
         ELSE auth_rate_limits.attempt_count + 1
       END,
       window_started_at = CASE
         WHEN auth_rate_limits.window_started_at < NOW() - INTERVAL '15 minutes' THEN NOW()
         ELSE auth_rate_limits.window_started_at
       END,
       updated_at = NOW()
     RETURNING attempt_count`,
    [bucketKey]
  );
  return Number(result.rows[0].attempt_count) <= 10;
}

async function reserveQuota(pool, userId, group, limit) {
  const result = await pool.query(
    `INSERT INTO daily_usage (user_id, usage_date, group_name, request_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (user_id, usage_date, group_name) DO UPDATE SET
       request_count = daily_usage.request_count + 1,
       updated_at = NOW()
     WHERE daily_usage.request_count < $4
     RETURNING request_count`,
    [userId, todayUtc(), group, limit]
  );
  if (!result.rowCount) return null;
  return Number(result.rows[0].request_count);
}

async function releaseQuota(pool, userId, group) {
  await pool.query(
    `UPDATE daily_usage
        SET request_count = GREATEST(request_count - 1, 0), updated_at = NOW()
      WHERE user_id = $1 AND usage_date = $2 AND group_name = $3`,
    [userId, todayUtc(), group]
  );
}

function providerRequest(model, config, messages) {
  if (config.provider === 'DeepSeek') {
    return {
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: process.env.DSAPI,
      body: { model, messages, stream: true, thinking: { type: 'disabled' } }
    };
  }
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OAAPI,
    body: {
      model,
      messages,
      stream: true,
      ...(config.flex ? { service_tier: 'flex' } : {})
    }
  };
}

function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

  app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; '));
    if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '256kb', type: 'application/json' }));

  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked.' });
    const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (!isAllowedOrigin(req.get('Origin'), expected)) return res.status(403).json({ error: 'Origin not allowed.' });
    next();
  });

  const optionalAuth = async (req, res, next) => {
    try {
      req.session = await readSession(pool, req);
      next();
    } catch (error) {
      next(error);
    }
  };
  const requireAuth = [optionalAuth, (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'Authentication required.' });
    next();
  }];
  const requireCsrf = (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies[CSRF_COOKIE];
    const headerToken = req.get('X-CSRF-Token');
    if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken) || hashToken(headerToken) !== req.session.csrf_hash) {
      return res.status(403).json({ error: 'Invalid security token.' });
    }
    next();
  };

  app.param('chatId', (req, res, next, value) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      return res.status(404).json({ error: 'Chat not found.' });
    }
    next();
  });

  app.get('/health', async (req, res, next) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/session', optionalAuth, (req, res) => {
    if (!req.session) return res.json({ authenticated: false });
    return res.json({ authenticated: true, user: publicUser(req.session) });
  });

  app.post('/api/auth/register', async (req, res, next) => {
    try {
      if (!(await checkAuthRateLimit(pool, req))) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      const email = normalizeEmail(req.body?.email);
      const displayName = normalizeDisplayName(req.body?.displayName);
      const password = req.body?.password;
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (displayName.length < 2) return res.status(400).json({ error: 'Name must contain at least 2 characters.' });
      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ error: passwordError });

      const passwordHash = await hashPassword(password);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const userId = crypto.randomUUID();
        const created = await client.query(
          `INSERT INTO users (id, email, display_name, password_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id AS user_id, email, display_name, created_at`,
          [userId, email, displayName, passwordHash]
        );
        await issueSession(client, res, userId);
        await client.query('COMMIT');
        return res.status(201).json({ user: publicUser(created.rows[0]) });
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' });
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      if (!(await checkAuthRateLimit(pool, req))) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password;
      const result = await pool.query(
        `SELECT id AS user_id, email, display_name, password_hash, created_at
           FROM users WHERE email = $1`,
        [email]
      );
      const user = result.rows[0];
      if (!user) {
        await hashPassword(typeof password === 'string' ? password : 'invalid-password-0');
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }
      if (!(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }
      await pool.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= NOW()', [user.user_id]);
      await issueSession(pool, res, user.user_id);
      return res.json({ user: publicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.session.token_hash]);
      clearAuthCookies(res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/account', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const password = req.body?.password;
      if (!(await verifyPassword(password, req.session.password_hash))) {
        return res.status(401).json({ error: 'Password is incorrect.' });
      }
      await pool.query('DELETE FROM users WHERE id = $1', [req.session.user_id]);
      clearAuthCookies(res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/models', ...requireAuth, (req, res) => {
    const models = Object.entries(MODEL_REGISTRY).map(([id, config]) => ({
      id,
      provider: config.provider,
      group: config.group,
      dailyLimit: config.limit
    }));
    res.json({ models });
  });

  app.get('/api/usage', ...requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT group_name, request_count FROM daily_usage
          WHERE user_id = $1 AND usage_date = $2`,
        [req.session.user_id, todayUtc()]
      );
      const counts = Object.fromEntries(result.rows.map((row) => [row.group_name, Number(row.request_count)]));
      const limits = {};
      for (const config of Object.values(MODEL_REGISTRY)) limits[config.group] = config.limit;
      res.json({ date: todayUtc(), usage: Object.entries(limits).map(([group, limit]) => ({ group, used: counts[group] || 0, limit })) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/chats', ...requireAuth, async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, title, model, created_at, updated_at
           FROM chats WHERE user_id = $1
          ORDER BY updated_at DESC LIMIT 100`,
        [req.session.user_id]
      );
      res.json({ chats: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/chats', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const model = MODEL_REGISTRY[req.body?.model] ? req.body.model : 'gpt-5.4-mini';
      const title = compactTitle(req.body?.title || 'New chat');
      const id = crypto.randomUUID();
      const result = await pool.query(
        `INSERT INTO chats (id, user_id, title, model)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, model, created_at, updated_at`,
        [id, req.session.user_id, title, model]
      );
      res.status(201).json({ chat: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/chats/:chatId', ...requireAuth, async (req, res, next) => {
    try {
      const chat = await pool.query(
        `SELECT id, title, model, created_at, updated_at
           FROM chats WHERE id = $1 AND user_id = $2`,
        [req.params.chatId, req.session.user_id]
      );
      if (!chat.rowCount) return res.status(404).json({ error: 'Chat not found.' });
      const messages = await pool.query(
        `SELECT id, role, content, created_at
           FROM messages WHERE chat_id = $1 AND user_id = $2
          ORDER BY created_at, id`,
        [req.params.chatId, req.session.user_id]
      );
      res.json({ chat: chat.rows[0], messages: messages.rows });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/chats/:chatId', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const title = compactTitle(req.body?.title);
      const result = await pool.query(
        `UPDATE chats SET title = $1, updated_at = NOW()
          WHERE id = $2 AND user_id = $3
          RETURNING id, title, model, created_at, updated_at`,
        [title, req.params.chatId, req.session.user_id]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Chat not found.' });
      res.json({ chat: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/chats/:chatId', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const result = await pool.query('DELETE FROM chats WHERE id = $1 AND user_id = $2', [req.params.chatId, req.session.user_id]);
      if (!result.rowCount) return res.status(404).json({ error: 'Chat not found.' });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/chats/:chatId/messages', ...requireAuth, requireCsrf, async (req, res, next) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const model = req.body?.model;
    const config = MODEL_REGISTRY[model];
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message must contain between 1 and ${MAX_MESSAGE_LENGTH} characters.` });
    }
    if (!config) return res.status(400).json({ error: 'Invalid model.' });

    let quotaReserved = false;
    let providerAccepted = false;
    let assistantText = '';
    let providerTimeout;
    try {
      const chat = await pool.query('SELECT id FROM chats WHERE id = $1 AND user_id = $2', [req.params.chatId, req.session.user_id]);
      if (!chat.rowCount) return res.status(404).json({ error: 'Chat not found.' });

      const used = await reserveQuota(pool, req.session.user_id, config.group, config.limit);
      if (used === null) return res.status(429).json({ error: 'Your daily limit for this model group has been reached.' });
      quotaReserved = true;

      await pool.query(
        `INSERT INTO messages (chat_id, user_id, role, content) VALUES ($1, $2, 'user', $3)`,
        [req.params.chatId, req.session.user_id, content]
      );
      await pool.query(
        `UPDATE chats
            SET title = CASE WHEN title = 'New chat' THEN $1 ELSE title END,
                model = $2, updated_at = NOW()
          WHERE id = $3 AND user_id = $4`,
        [compactTitle(content), model, req.params.chatId, req.session.user_id]
      );

      const historyResult = await pool.query(
        `SELECT role, content FROM (
           SELECT id, role, content, created_at
             FROM messages WHERE chat_id = $1 AND user_id = $2
            ORDER BY created_at DESC, id DESC LIMIT 12
         ) recent ORDER BY created_at, id`,
        [req.params.chatId, req.session.user_id]
      );

      const provider = providerRequest(model, config, historyResult.rows.map(({ role, content: messageContent }) => ({ role, content: messageContent })));
      if (!provider.apiKey) {
        await releaseQuota(pool, req.session.user_id, config.group);
        quotaReserved = false;
        return res.status(503).json({ error: `${config.provider} is not configured.` });
      }

      const controller = new AbortController();
      providerTimeout = setTimeout(() => controller.abort(), 120_000);
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const upstream = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify(provider.body),
        signal: controller.signal
      });

      if (!upstream.ok || !upstream.body) {
        clearTimeout(providerTimeout);
        providerTimeout = null;
        await releaseQuota(pool, req.session.user_id, config.group);
        quotaReserved = false;
        return res.status(502).json({ error: 'The model provider rejected the request.' });
      }
      providerAccepted = true;

      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-RateLimit-Group', config.group);
      res.setHeader('X-RateLimit-Limit', String(config.limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(config.limit - used, 0)));
      res.flushHeaders();

      const textDecoder = new TextDecoder();
      const parser = new SseTextDecoder((text) => {
        if (Buffer.byteLength(assistantText, 'utf8') + Buffer.byteLength(text, 'utf8') > MAX_PROVIDER_OUTPUT_BYTES) {
          throw new Error('Provider output exceeded the safety limit.');
        }
        assistantText += text;
        if (!res.destroyed) res.write(text);
      });
      for await (const chunk of upstream.body) parser.push(textDecoder.decode(chunk, { stream: true }));
      parser.push(textDecoder.decode());
      parser.flush();
      clearTimeout(providerTimeout);
      providerTimeout = null;

      if (assistantText.trim()) {
        await pool.query(
          `INSERT INTO messages (chat_id, user_id, role, content) VALUES ($1, $2, 'assistant', $3)`,
          [req.params.chatId, req.session.user_id, assistantText]
        );
        await pool.query('UPDATE chats SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [req.params.chatId, req.session.user_id]);
      }
      if (!res.destroyed) res.end();
    } catch (error) {
      if (providerTimeout) clearTimeout(providerTimeout);
      if (quotaReserved && !providerAccepted) {
        try { await releaseQuota(pool, req.session.user_id, config.group); } catch {}
      }
      console.error(`[${req.requestId}] chat request failed:`, error.message);
      if (!res.headersSent) return next(error);
      if (!res.destroyed) res.end('\n\nThe response was interrupted. Please try again.');
    }
  });

  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), {
    dotfiles: 'deny',
    etag: true,
    fallthrough: false,
    maxAge: IS_PRODUCTION ? '1h' : 0
  }));

  app.get('/', optionalAuth, (req, res) => {
    if (req.session) return res.redirect('/app');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
  app.get(['/app', '/console'], optionalAuth, (req, res) => {
    if (!req.session) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(PUBLIC_DIR, 'console.html'));
  });
  app.get(['/robots.txt', '/Robots.txt', '/robot.txt'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'robots.txt')));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
    return res.redirect('/');
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
    console.error(`[${req.requestId || 'unknown'}] request failed:`, error.message);
    return res.status(500).json({ error: 'Internal server error.', requestId: req.requestId });
  });

  return app;
}

async function start() {
  const pool = createPool();
  await migrate(pool);
  const app = createApp(pool);
  const server = app.listen(PORT, () => console.log(`EtherKing listening on port ${PORT}`));

  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start EtherKing:', error.message);
    process.exit(1);
  });
}

module.exports = { MODEL_REGISTRY, createApp, migrate, reserveQuota };

