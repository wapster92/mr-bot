# Repository Guidelines

## Project Structure & Module Organization
- Core entry: `src/index.ts` wires Express, bot startup mode (long-polling vs webhook), and lifecycle signals.
- Bot logic: `src/bot.ts` wires middleware and commands; `src/config.ts` parses env-driven settings; Mongo helpers in `src/db/mongo.ts`.
- Messaging: `src/messages/` contains HTML formatting, templates, and reply pools; `src/services/` builds summaries (e.g., `/mrs`).
- Middleware: `src/middleware/` handles incoming message logging and auth gates.
- GitLab integration: `src/gitlab/webhook.ts` builds the webhook endpoint; events can be persisted via `src/gitlab/eventStore.ts` (logs land in `logs/gitlab-events/`).
- User data now lives in Mongo `users` (whitelist, roles, work hours).
- Static data/helpers: `src/data/*.ts` holds reviewer queues and repositories; adjust these before shipping.
- Deployment assets live in `deploy/` (e.g., `nginx.conf`), docs in `docs/`, and compiled output in `dist/` after building.

## Build, Test, and Development Commands
- `npm install` to install deps; copy `.env.example` to `.env` and fill required values (`TELEGRAM_BOT_TOKEN`, Mongo, webhook settings).
- `npm run dev`: run locally with auto-reload (ts-node-dev) in long-polling mode; hit `/healthz` or `/debug/ping` to sanity-check.
- `npm run build`: type-check and emit JS + declarations into `dist/`.
- `npm start`: run the compiled bot from `dist/`.
- Docker: `docker compose up --build -d` to build/run; `docker compose logs -f bot` for logs, `docker compose restart bot` to reload config.

## Coding Style & Naming Conventions
- Language: TypeScript in strict mode (`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Formatting: 2-space indent, semicolons, single quotes; keep imports sorted by locality (built-ins → external → local).
- Config/env access goes through `src/config.ts`; avoid reading `process.env` directly elsewhere.
- Prefer explicit types on exports and public helpers; keep async code `async/await`-first.

## Testing Guidelines
- No automated suite is present; when adding tests, prefer `node:test` + `ts-node`/`ts-jest` with files named `*.spec.ts` under `tests/` or near the code.
- For behavioral checks today, rely on `npm run dev` plus Telegram `/start` flow and the `/debug/ping` endpoint; ensure Mongo connectivity before testing.
- When touching webhook handling, capture/inspect payloads in `logs/gitlab-events/` to verify shape before shipping.

## Commit & Pull Request Guidelines
- Follow existing history: short, imperative Russian summaries (e.g., “Исправил …”, “Добавил …”); keep messages focused on one change set.
- PRs should include: what changed, why, how to verify (commands, curl examples), and any env variable or config impacts.
- Link related GitLab/Jira issues; add before/after logs or screenshots when altering user-visible bot replies.
- Run `npm run build` (or compose build) before requesting review to catch type regressions.
