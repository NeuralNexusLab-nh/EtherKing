# EtherKing

EtherKing is an account-based, multi-model chat application with server-persisted conversations, per-user rolling point limits, background generation, and a responsive dark/light interface.

## Features

- Email/password registration, login, logout, and permanent account deletion
- Opaque server-side sessions stored in a local data file
- Chats, messages, background generation state, auth throttles, and per-user quotas persisted across restarts
- OpenAI, DeepSeek, and Ollama cloud model support
- Authentication and CSRF validation for chat, usage, and account operations
- SameSite cookies, same-origin enforcement, strict security headers, login throttling, and request size limits
- Safe text/code rendering with no model-controlled HTML or executable code iframe
- A clean, responsive interface with dark and light themes only

## Storage

Runtime data is written to `data/store.json`. The payload is Base64-obfuscated so the file is not immediately human-readable, but it is **not encrypted** and must not be treated as encrypted storage.

Writes are serialized and use a temporary file plus rename to avoid leaving a partially written store. The `data/` directory is excluded from Git.

This storage mode is intended for one application process on a host with a persistent filesystem. Do not run multiple EtherKing instances against the same file. Back up `data/store.json` before upgrades or host migrations.

## Requirements

- Node.js 20 or newer
- A host with a persistent writable filesystem
- An OpenAI, DeepSeek, or Ollama API key
- HTTPS in production

## Setup

```bash
cp .env.example .env
npm install
npm test
npm start
```

The `data/` directory and initial store file are created automatically on startup.

## Environment variables

EtherKing reads only these environment variables:

| Name | Required | Description |
| --- | --- | --- |
| `PORT` | No | HTTP port, defaults to `3000`. |
| `OAAPI` | For OpenAI models | OpenAI API key. Never expose it to the browser. |
| `DSAPI` | For DeepSeek models | DeepSeek API key. Never expose it to the browser. |
| `OLAPI` | For Ollama models | Ollama cloud API key for `https://ollama.com/api`. Never expose it to the browser. |

## Deployment notes

1. Mount persistent storage for the repository's `data/` directory.
2. Terminate traffic with HTTPS. Secure cookies and HSTS are enabled automatically when the request is HTTPS or the proxy supplies `X-Forwarded-Proto: https`.
3. Add provider keys as protected platform secrets.
4. Run exactly one application instance for each data file.
5. Back up `data/store.json` and test restoration regularly.

Existing browser-only conversations from the original release cannot be migrated automatically because they never reached the server.

## Security model

- Passwords use Node.js `scrypt` with a unique random salt; passwords are never stored directly.
- Session and CSRF tokens are random; only SHA-256 token hashes are stored in the file.
- Session cookies are HttpOnly and SameSite Strict, and become Secure over HTTPS.
- Account deletion removes the user's sessions, chats, messages, and quota records from the file.
- Provider responses are rendered through DOM text nodes. Raw model HTML is never inserted into the page.
- Frontend and API responses use `no-store`; static assets do not use ETags or browser cache lifetimes.
- API request bodies, passwords, session tokens, chat content, and provider keys are not logged.
- Base64 storage obfuscation is not encryption. Anyone who can read the file can decode its contents.

Run `npm test` and `npm run check` before each deployment.

