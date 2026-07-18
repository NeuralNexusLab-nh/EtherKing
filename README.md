# EtherKing

EtherKing is an account-based, multi-model chat application. It provides secure registration and login, cloud-backed conversations, per-user daily model limits, and a responsive dark/light interface.

## What changed in v2

- Email/password registration, login, logout, and permanent account deletion
- Opaque server-side sessions stored in PostgreSQL
- Chats and messages stored per user in PostgreSQL instead of `localStorage`
- Atomic per-user daily quotas for each model group
- Authentication required for every model, usage, chat, and account API
- SameSite cookies, CSRF tokens, same-origin enforcement, strict security headers, login throttling, and request size limits
- Safe text/code rendering with no model-controlled HTML and no executable code iframe
- A clean, responsive interface with dark and light themes only

## Requirements

- Node.js 20 or newer
- PostgreSQL 14 or newer
- An OpenAI API key, a DeepSeek API key, or both
- HTTPS in production

## Local setup

```bash
cp .env.example .env
npm install
npm test
npm start
```

Set the environment variables from `.env.example` in your shell or deployment platform. The application creates its tables automatically on startup.

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Use a managed persistent database in production. |
| `APP_ORIGIN` | Production | Canonical HTTPS origin, for example `https://chat.example.com`. |
| `OAAPI` | For OpenAI models | OpenAI API key. Never expose it to the browser. |
| `DSAPI` | For DeepSeek models | DeepSeek API key. Never expose it to the browser. |
| `NODE_ENV` | Recommended | Set to `production` to enable Secure cookies and HSTS. |
| `DATABASE_SSL` | Platform-specific | Set to `true` when the database requires verified TLS. |
| `TRUST_PROXY` | Platform-specific | Set to `true` only behind one trusted reverse proxy. |
| `PORT` | No | HTTP port, defaults to `3000`. |
| `DATABASE_POOL_SIZE` | No | Maximum PostgreSQL pool size, defaults to `10`. |

## Deployment notes

1. Provision persistent PostgreSQL. The application no longer writes runtime data to the local filesystem.
2. Set `NODE_ENV=production` and an HTTPS `APP_ORIGIN`.
3. Add provider keys as encrypted platform secrets.
4. If a platform terminates TLS at exactly one reverse proxy, set `TRUST_PROXY=true`; otherwise leave it disabled.
5. Keep PostgreSQL backups and define an account-data retention policy.

Existing browser-only conversations from the original release cannot be migrated automatically because they never reached the server. Users can retain them by exporting their browser storage before deployment if needed.

## Security model

- Passwords use Node.js `scrypt` with a unique random salt.
- Session and CSRF tokens are random; only SHA-256 token hashes are stored.
- Session cookies are HttpOnly, SameSite Strict, and Secure in production.
- Account deletion relies on PostgreSQL cascading deletes and requires the current password.
- Provider responses are rendered through DOM text nodes. Raw model HTML is never inserted into the page.
- API request bodies, passwords, session tokens, chat content, and provider keys are not logged.

Run `npm test` and `npm run check` before each deployment.

