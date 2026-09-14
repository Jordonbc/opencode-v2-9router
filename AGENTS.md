# AGENTS.md

Single-package TypeScript ESM OpenCode V2 plugin (`src/index.ts`). Strict TS, `NodeNext`, target ES2022, Node >=20. One runtime dep: pinned `@opencode-ai/plugin` beta — re-check SDK contract before upgrading it or `opencode2`.

## Commands

- `npm ci` — install.
- `npm test` — compiles (`tsc`) then runs `node --test dist/tests/*.test.js`. Tests execute from `dist/`, never `tests/*.ts` directly.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run coverage` — compiles then runs `node --test --experimental-test-coverage dist/tests/*.test.js`. All four `src` modules must stay at 100% line/branch/function.
- `npm run release:check` — `test + typecheck + npm pack --dry-run`. Run before publishing.
- CI (`.github/workflows/ci.yml`): `npm ci` → `npm test` → `npm run typecheck` → `npm pack --dry-run`.
- No lint/format/pre-commit config. No `opencode.json` instructions.

## Architecture

- `src/index.ts` — default export is `createPlugin()` V2 definition (`id: opencode.9router`). `setup` registers one replayable `catalog.transform`; fail-soft (warn once via `console.warn`, return, never throw).
- `src/config.ts` — env `OPENCODE_9ROUTER_URL` / `OPENCODE_9ROUTER_API_KEY`, per-key fallback to `~/.config/environment.d/9router.conf`. Env wins. URL must be `http(s)`, end in `/v1`, no credentials/query/fragment.
- `src/discovery.ts` — single `GET <baseURL>/models` with Bearer auth, `redirect: "error"`, 5s timeout, 1 MiB cap. Keeps the first 1000 usable models and reports the dropped count via `onTruncated`. Dedupes by ID, preserves upstream IDs exactly, ignores IDs with whitespace/control chars or >512 chars. Releases the reader lock on every path; cancels the stream on failures.
- `src/provider.ts` — registers provider `9router` (`9Router`) with `package: aisdk:@ai-sdk/openai-compatible`; each model sets `package` the same, `modelID` = full discovered route, name derived from last `/` segment. `model.api` shape is a stale snapshot — do not use.

## Gotchas

- Never log response bodies, exception text, or secrets. Failure paths warn with fixed strings only (`plugin.test.ts` asserts the key is absent).
- Reasoning variants only for `capabilities.reasoning === true`; mirror the direct OpenCode model's efforts when present, else fallback `low/medium/high/xhigh` plus `none` only if `thinkingCanDisable`. Never invent `max`.
- Copy only `context_length`/`max_completion_tokens` (or capability equivalents) into limits; leave pricing/other metadata at SDK defaults.
- `createPlugin(deps)` accepts injectable `{config, discover, warn}` — use this in tests instead of network/env.
- `dist/`, `node_modules/`, `*.tgz` are gitignored; package ships `src/` directly to OpenCode's Bun runtime, so keep lifecycle scripts out of `package.json`.

@RTK.md
