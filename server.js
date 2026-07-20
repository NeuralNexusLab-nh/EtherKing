'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { FileStore } = require('./lib/storage');
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
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
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

function isSecureRequest(req) {
  const forwardedProtocol = String(req.get('X-Forwarded-Proto') || '').split(',')[0].trim().toLowerCase();
  return req.secure || forwardedProtocol === 'https';
}

function requestOrigin(req) {
  const forwardedProtocol = String(req.get('X-Forwarded-Proto') || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProtocol === 'https' ? 'https' : req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function cookieOptions(req, httpOnly) {
  return {
    httpOnly,
    secure: isSecureRequest(req),
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS
  };
}

function clearAuthCookies(req, res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req, true));
  res.clearCookie(CSRF_COOKIE, cookieOptions(req, false));
}

function newSession(userId) {
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const now = new Date();
  return {
    sessionToken,
    csrfToken,
    record: {
      tokenHash: hashToken(sessionToken),
      csrfHash: hashToken(csrfToken),
      userId,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString()
    }
  };
}

function setSessionCookies(req, res, session) {
  res.cookie(SESSION_COOKIE, session.sessionToken, cookieOptions(req, true));
  res.cookie(CSRF_COOKIE, session.csrfToken, cookieOptions(req, false));
}

async function readSession(store, req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token || token.length > 256) return null;
  const tokenHash = hashToken(token);
  const now = Date.now();
  const session = store.read((data) => {
    const record = data.sessions.find((item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt) > now);
    if (!record) return null;
    const user = data.users.find((item) => item.id === record.userId);
    return user ? { ...record, user } : null;
  });
  if (!session) return null;
  if (Date.parse(session.lastSeenAt) < now - 15 * 60 * 1000) {
    store.mutate((data) => {
      const record = data.sessions.find((item) => item.tokenHash === tokenHash);
      if (record) record.lastSeenAt = new Date().toISOString();
    }).catch(() => {});
  }
  return session;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt
  };
}

async function checkAuthRateLimit(store, req) {
  const bucketKey = hashToken(`auth:${req.ip || req.socket?.remoteAddress || 'unknown'}`);
  return store.mutate((data) => {
    const now = Date.now();
    const cutoff = now - 15 * 60 * 1000;
    data.authRateLimits = data.authRateLimits.filter((item) => Date.parse(item.updatedAt) > now - 24 * 60 * 60 * 1000);
    let bucket = data.authRateLimits.find((item) => item.bucketKey === bucketKey);
    if (!bucket) {
      bucket = { bucketKey, windowStartedAt: new Date(now).toISOString(), attemptCount: 0, updatedAt: new Date(now).toISOString() };
      data.authRateLimits.push(bucket);
    }
    if (Date.parse(bucket.windowStartedAt) < cutoff) {
      bucket.windowStartedAt = new Date(now).toISOString();
      bucket.attemptCount = 0;
    }
    bucket.attemptCount += 1;
    bucket.updatedAt = new Date(now).toISOString();
    return bucket.attemptCount <= 10;
  });
}

async function reserveQuota(store, userId, group, limit) {
  return store.mutate((data) => {
    const date = todayUtc();
    let usage = data.dailyUsage.find((item) => item.userId === userId && item.date === date && item.group === group);
    if (!usage) {
      usage = { userId, date, group, count: 0, updatedAt: new Date().toISOString() };
      data.dailyUsage.push(usage);
    }
    if (usage.count >= limit) return null;
    usage.count += 1;
    usage.updatedAt = new Date().toISOString();
    data.dailyUsage = data.dailyUsage.filter((item) => item.date >= new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    return usage.count;
  });
}

async function releaseQuota(store, userId, group) {
  await store.mutate((data) => {
    const usage = data.dailyUsage.find((item) => item.userId === userId && item.date === todayUtc() && item.group === group);
    if (usage) {
      usage.count = Math.max(usage.count - 1, 0);
      usage.updatedAt = new Date().toISOString();
    }
  });
}

function providerRequest(model, config, history) {
  if (config.provider === 'DeepSeek') {
    return {
      url: 'https://api.deepseek.com/chat/completions',
      apiKey: process.env.DSAPI,
      body: { model, messages: history, stream: true, thinking: { type: 'disabled' } }
    };
  }
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OAAPI,
    body: { model, messages: history, stream: true, ...(config.flex ? { service_tier: 'flex' } : {}) }
  };
}

function serializeChat(chat) {
  return {
    id: chat.id,
    title: chat.title,
    model: chat.model,
    created_at: chat.createdAt,
    updated_at: chat.updatedAt
  };
}

function serializeMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    created_at: message.createdAt
  };
}

function createApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

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
    if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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
    if (!isAllowedOrigin(req.get('Origin'), requestOrigin(req))) return res.status(403).json({ error: 'Origin not allowed.' });
    next();
  });

  const optionalAuth = async (req, res, next) => {
    try {
      req.session = await readSession(store, req);
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
    if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken) || hashToken(headerToken) !== req.session.csrfHash) {
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

  app.get('/health', (req, res) => {
    store.read(() => true);
    res.json({ status: 'ok' });
  });

  app.get('/api/session', optionalAuth, (req, res) => {
    if (!req.session) return res.json({ authenticated: false });
    return res.json({ authenticated: true, user: publicUser(req.session.user) });
  });

  app.post('/api/auth/register', async (req, res, next) => {
    try {
      if (!(await checkAuthRateLimit(store, req))) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      const email = normalizeEmail(req.body?.email);
      const displayName = normalizeDisplayName(req.body?.displayName);
      const password = req.body?.password;
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (displayName.length < 2) return res.status(400).json({ error: 'Name must contain at least 2 characters.' });
      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ error: passwordError });

      const passwordHash = await hashPassword(password);
      const user = {
        id: crypto.randomUUID(),
        email,
        displayName,
        passwordHash,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const session = newSession(user.id);
      try {
        await store.mutate((data) => {
          if (data.users.some((item) => item.email === email)) {
            const error = new Error('Duplicate email.');
            error.code = 'DUPLICATE_EMAIL';
            throw error;
          }
          data.users.push(user);
          data.sessions.push(session.record);
        });
      } catch (error) {
        if (error.code === 'DUPLICATE_EMAIL') return res.status(409).json({ error: 'An account with this email already exists.' });
        throw error;
      }
      setSessionCookies(req, res, session);
      return res.status(201).json({ user: publicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      if (!(await checkAuthRateLimit(store, req))) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password;
      const user = store.read((data) => data.users.find((item) => item.email === email) || null);
      if (!user) {
        await hashPassword(typeof password === 'string' ? password : 'invalid-password-0');
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }
      if (!(await verifyPassword(password, user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
      const session = newSession(user.id);
      await store.mutate((data) => {
        data.sessions = data.sessions.filter((item) => item.userId !== user.id || Date.parse(item.expiresAt) > Date.now());
        data.sessions.push(session.record);
      });
      setSessionCookies(req, res, session);
      return res.json({ user: publicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      await store.mutate((data) => {
        data.sessions = data.sessions.filter((item) => item.tokenHash !== req.session.tokenHash);
      });
      clearAuthCookies(req, res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/account', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      if (!(await verifyPassword(req.body?.password, req.session.user.passwordHash))) {
        return res.status(401).json({ error: 'Password is incorrect.' });
      }
      const userId = req.session.userId;
      await store.mutate((data) => {
        const chatIds = new Set(data.chats.filter((chat) => chat.userId === userId).map((chat) => chat.id));
        data.users = data.users.filter((user) => user.id !== userId);
        data.sessions = data.sessions.filter((session) => session.userId !== userId);
        data.chats = data.chats.filter((chat) => chat.userId !== userId);
        data.messages = data.messages.filter((message) => !chatIds.has(message.chatId));
        data.dailyUsage = data.dailyUsage.filter((usage) => usage.userId !== userId);
      });
      clearAuthCookies(req, res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/models', ...requireAuth, (req, res) => {
    const models = Object.entries(MODEL_REGISTRY).map(([id, config]) => ({ id, provider: config.provider, group: config.group, dailyLimit: config.limit }));
    res.json({ models });
  });

  app.get('/api/usage', ...requireAuth, (req, res) => {
    const limits = {};
    for (const config of Object.values(MODEL_REGISTRY)) limits[config.group] = config.limit;
    const counts = store.read((data) => Object.fromEntries(data.dailyUsage
      .filter((item) => item.userId === req.session.userId && item.date === todayUtc())
      .map((item) => [item.group, item.count])));
    res.json({ date: todayUtc(), usage: Object.entries(limits).map(([group, limit]) => ({ group, used: counts[group] || 0, limit })) });
  });

  app.get('/api/chats', ...requireAuth, (req, res) => {
    const chats = store.read((data) => data.chats
      .filter((chat) => chat.userId === req.session.userId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 100)
      .map(serializeChat));
    res.json({ chats });
  });

  app.post('/api/chats', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const now = new Date().toISOString();
      const chat = {
        id: crypto.randomUUID(),
        userId: req.session.userId,
        title: compactTitle(req.body?.title || 'New chat'),
        model: MODEL_REGISTRY[req.body?.model] ? req.body.model : 'gpt-5.4-mini',
        createdAt: now,
        updatedAt: now
      };
      await store.mutate((data) => data.chats.push(chat));
      res.status(201).json({ chat: serializeChat(chat) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/chats/:chatId', ...requireAuth, (req, res) => {
    const result = store.read((data) => {
      const chat = data.chats.find((item) => item.id === req.params.chatId && item.userId === req.session.userId);
      if (!chat) return null;
      const messages = data.messages.filter((message) => message.chatId === chat.id && message.userId === req.session.userId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map(serializeMessage);
      return { chat: serializeChat(chat), messages };
    });
    if (!result) return res.status(404).json({ error: 'Chat not found.' });
    res.json(result);
  });

  app.patch('/api/chats/:chatId', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const chat = await store.mutate((data) => {
        const item = data.chats.find((candidate) => candidate.id === req.params.chatId && candidate.userId === req.session.userId);
        if (!item) return null;
        item.title = compactTitle(req.body?.title);
        item.updatedAt = new Date().toISOString();
        return item;
      });
      if (!chat) return res.status(404).json({ error: 'Chat not found.' });
      res.json({ chat: serializeChat(chat) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/chats/:chatId', ...requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const deleted = await store.mutate((data) => {
        const exists = data.chats.some((chat) => chat.id === req.params.chatId && chat.userId === req.session.userId);
        if (!exists) return false;
        data.chats = data.chats.filter((chat) => chat.id !== req.params.chatId || chat.userId !== req.session.userId);
        data.messages = data.messages.filter((message) => message.chatId !== req.params.chatId || message.userId !== req.session.userId);
        return true;
      });
      if (!deleted) return res.status(404).json({ error: 'Chat not found.' });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/chats/:chatId/messages', ...requireAuth, requireCsrf, async (req, res, next) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const model = req.body?.model;
    const config = MODEL_REGISTRY[model];
    if (!content || content.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: `Message must contain between 1 and ${MAX_MESSAGE_LENGTH} characters.` });
    if (!config) return res.status(400).json({ error: 'Invalid model.' });

    let quotaReserved = false;
    let providerAccepted = false;
    let assistantText = '';
    let providerTimeout;
    try {
      const chatExists = store.read((data) => data.chats.some((chat) => chat.id === req.params.chatId && chat.userId === req.session.userId));
      if (!chatExists) return res.status(404).json({ error: 'Chat not found.' });

      const used = await reserveQuota(store, req.session.userId, config.group, config.limit);
      if (used === null) return res.status(429).json({ error: 'Your daily limit for this model group has been reached.' });
      quotaReserved = true;

      await store.mutate((data) => {
        const now = new Date().toISOString();
        data.messages.push({ id: crypto.randomUUID(), chatId: req.params.chatId, userId: req.session.userId, role: 'user', content, createdAt: now });
        const chat = data.chats.find((item) => item.id === req.params.chatId && item.userId === req.session.userId);
        if (chat) {
          if (chat.title === 'New chat') chat.title = compactTitle(content);
          chat.model = model;
          chat.updatedAt = now;
        }
      });

      const history = store.read((data) => data.messages
        .filter((message) => message.chatId === req.params.chatId && message.userId === req.session.userId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(-12)
        .map((message) => ({ role: message.role, content: message.content })));
      const provider = providerRequest(model, config, history);
      if (!provider.apiKey) {
        await releaseQuota(store, req.session.userId, config.group);
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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(provider.body),
        signal: controller.signal
      });

      if (!upstream.ok || !upstream.body) {
        clearTimeout(providerTimeout);
        providerTimeout = null;
        await releaseQuota(store, req.session.userId, config.group);
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
        if (Buffer.byteLength(assistantText, 'utf8') + Buffer.byteLength(text, 'utf8') > MAX_PROVIDER_OUTPUT_BYTES) throw new Error('Provider output exceeded the safety limit.');
        assistantText += text;
        if (!res.destroyed) res.write(text);
      });
      for await (const chunk of upstream.body) parser.push(textDecoder.decode(chunk, { stream: true }));
      parser.push(textDecoder.decode());
      parser.flush();
      clearTimeout(providerTimeout);
      providerTimeout = null;

      if (assistantText.trim()) {
        await store.mutate((data) => {
          const now = new Date().toISOString();
          data.messages.push({ id: crypto.randomUUID(), chatId: req.params.chatId, userId: req.session.userId, role: 'assistant', content: assistantText, createdAt: now });
          const chat = data.chats.find((item) => item.id === req.params.chatId && item.userId === req.session.userId);
          if (chat) chat.updatedAt = now;
        });
      }
      if (!res.destroyed) res.end();
    } catch (error) {
      if (providerTimeout) clearTimeout(providerTimeout);
      if (quotaReserved && !providerAccepted) {
        try { await releaseQuota(store, req.session.userId, config.group); } catch {}
      }
      console.error(`[${req.requestId}] chat request failed:`, error.message);
      if (!res.headersSent) return next(error);
      if (!res.destroyed) res.end('\n\nThe response was interrupted. Please try again.');
    }
  });

  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { dotfiles: 'deny', etag: true, fallthrough: false, maxAge: '1h' }));
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
  const store = await new FileStore(DATA_FILE).init();
  const app = createApp(store);
  const server = app.listen(PORT, () => console.log(`EtherKing listening on port ${PORT}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start EtherKing:', error.message);
    process.exit(1);
  });
}

module.exports = { DATA_FILE, MODEL_REGISTRY, createApp, reserveQuota };

