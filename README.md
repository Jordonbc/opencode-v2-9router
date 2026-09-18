# opencode-9router-v2

Unofficial native OpenCode V2 plugin that discovers models from a private 9Router OpenAI-compatible gateway, plus native support for an OmniRoute gateway as a second, independent provider. It was built against `opencode v2.0.6` and `@opencode/plugin 2.0.6`.

OpenCode V2 is still a preview. Re-check the plugin SDK contract before upgrading either pinned beta dependency.

## What it does

- Reads `OPENCODE_9ROUTER_URL` and `OPENCODE_9ROUTER_API_KEY`.
- Falls back per missing variable to `~/.config/environment.d/9router.conf`.
- Calls `GET <baseURL>/models` once at plugin setup with Bearer authentication.
- Registers provider `9router` as `9Router` and preserves upstream IDs exactly.
- Exposes OpenCode reasoning variants for models whose live 9Router metadata advertises reasoning.
- Mirrors the transport/package metadata from the matching direct OpenCode model where possible (for example `aisdk:@ai-sdk/openai` for Responses-native models, `aisdk:@ai-sdk/anthropic` for Anthropic-native models), with `aisdk:@ai-sdk/openai-compatible` as fallback. The 9router `baseURL`/`apiKey` are always used; OpenCode is never pointed directly at `opencode.ai`.
- Warns once and lets OpenCode continue if configuration or discovery fails.
- Optionally registers a second provider for OmniRoute (see below). OmniRoute failure can never break 9Router, and vice versa.

It does not execute commands, scan projects, or contact metadata services beyond the configured gateways.

## Configure

The URL must end in `/v1`:

```sh
export OPENCODE_9ROUTER_URL="http://127.0.0.1:20128/v1"
export OPENCODE_9ROUTER_API_KEY="your-key"
```

On Linux, the plugin can instead read:

```ini
# ~/.config/environment.d/9router.conf
OPENCODE_9ROUTER_URL=http://127.0.0.1:20128/v1
OPENCODE_9ROUTER_API_KEY=your-key
```

Environment variables override file values. Protect the file with `chmod 600 ~/.config/environment.d/9router.conf` and restart OpenCode after changing configuration.

## OmniRoute (second provider)

The same installed plugin can also expose an OmniRoute gateway as a separate provider (default id `omniroute`, display name `OmniRoute`). No `opencode.json` change is required. When `OPENCODE_OMNIROUTE_URL` is unset, OmniRoute stays silent and disabled.

```sh
export OPENCODE_OMNIROUTE_URL="http://127.0.0.1:20128"
export OPENCODE_OMNIROUTE_API_KEY="your-key"
# Optional distinct management credential for /api/* endpoints:
export OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY="your-management-key"
```

Compatibility fallbacks `OMNIROUTE_API_KEY` / `OMNIROUTE_MANAGEMENT_API_KEY` and a per-key fallback file at `~/.config/environment.d/omniroute.conf` are also recognised. A credential stored through OpenCode's native integration (`/connect`) wins over environment keys.

Behaviour (adapted to this repo's `provider.transform` API):

- Live models from `GET <root>/v1/models` (accepts `{data:[...]}` and bare arrays).
- Combos from `GET <root>/api/combos` with bounded nested-combo resolution, least-common capabilities, hidden/combo-cycle handling and model-ID collision warnings.
- Auto-combos from `GET <root>/api/combos/auto` (404 means none; future variants are accepted without code changes).
- Optional enrichment (friendly names, provider tags, pricing, free-tier budgets) from `/api/pricing/models`, `/api/pricing` and `/api/free-tier/summary`; failures degrade to raw names.
- Canonical/alias dedupe driven by enrichment metadata (no hardcoded provider table).
- Optional usable-provider filtering (`OPENCODE_OMNIROUTE_USABLE_ONLY=1`, fail-open), visible/hidden model lists (`OPENCODE_OMNIROUTE_VISIBLE_MODELS`, `OPENCODE_OMNIROUTE_HIDDEN_MODELS`, comma-separated, deny wins).
- Optional Anthropic-format routing (`OPENCODE_OMNIROUTE_ALLOW_ANTHROPIC=1` with `OPENCODE_OMNIROUTE_ANTHROPIC_MODELS`; both formats stay on the OmniRoute gateway).
- Gemini tool-schema sanitisation for Gemini-routed models (disable with `OPENCODE_OMNIROUTE_GEMINI_SANITIZATION=0`).
- In-memory TTL cache (`OPENCODE_OMNIROUTE_CACHE_TTL_MS`, default 300000) with refresh coalescing, last-known-good fallback and a disk warm-start snapshot honouring `OPENCODE_DATA_DIR` (atomic writes, `0600`, credential-bound fingerprint, no secrets stored).

Further tuning: `OPENCODE_OMNIROUTE_PROVIDER_ID`, `OPENCODE_OMNIROUTE_DISPLAY_NAME`, `OPENCODE_OMNIROUTE_TIMEOUT_MS` plus per-endpoint `..._MODELS/COMBOS/AUTO_COMBOS/ENRICHMENT_TIMEOUT_MS`, `OPENCODE_OMNIROUTE_ENRICHMENT=0`, `OPENCODE_OMNIROUTE_PROVIDER_TAG=0`, `OPENCODE_OMNIROUTE_LOG_LEVEL`.

## Develop locally

```sh
git clone <your-repository-url> opencode-9router-v2
cd opencode-9router-v2
npm ci
npm run test
npm run compile
```

All generated files remain inside the cloned repository. The project does not require or create a top-level wrapper or symlink in OpenCode's `plugins` directory.

## Install from GitHub

Install the GitHub repository directly:

```sh
opencode2 plugin add git+https://github.com/Jordonbc/opencode-v2-9router.git
```

Restart OpenCode, then verify each layer:

```sh
opencode2 models --standalone | grep '^9router/'
opencode2 run --standalone --model 9router/ocg/muse-spark-1.3-contributor Hello
```

In the TUI, `/models` should show provider `9Router` and names such as `Muse Spark 1.3 Contributor (ocg)`.

For a tool round trip, ask the selected model to use a harmless built-in tool, such as listing the current directory, and confirm the tool result is incorporated into its answer.

## Uninstall

Remove the same Git package specifier used for installation:

```sh
opencode2 plugin remove git+https://github.com/Jordonbc/opencode-v2-9router.git
```

Then restart OpenCode. Removing the plugin does not modify `~/.config/environment.d/9router.conf`.

## Why these V2 fields matter

This is not a V1 config-hook plugin. Its default export is a V2 definition with an `id` and `setup` function from `@opencode/plugin`. Setup registers a replayable `provider.transform`.

The provider sets `package` to `@opencode/ai/providers/openai-compatible` as the generic fallback. Each discovered model sets `package` to the matching direct OpenCode model's transport when one exists, otherwise the same compatible fallback. The `@opencode/ai/providers/` discriminator selects OpenCode's AI SDK resolver, which normalizes the remainder to the official provider package. For example `ocg/muse-spark-1.3-contributor` mirrors `@opencode/ai/providers/openai` so OpenCode sends native Responses format instead of chat format that would require `openai→openai-responses` translation. Provider `settings.baseURL` always selects the configured 9router gateway, while `settings.apiKey` is resolved by that transport into `Authorization: Bearer <key>`; direct-model connection settings are never copied, so traffic stays on 9router. Each model's catalog key remains its full discovered route and `modelID` repeats that exact value, which is the identifier sent upstream. The provider is published via `editor.add` (or `editor.update` when it already exists) and the discovered inventory is written with `editor.models.set`; the older `catalog.transform` / `model.api` shapes belong to a V2 beta snapshot.

For a discovered route that matches a model already known to OpenCode, the plugin mirrors that model's exact OpenAI-compatible reasoning-effort variants. This prevents the plugin from inventing `max` for a model whose direct OpenCode entry stops at `xhigh`. If no direct model matches, the conservative fallback is `low`, `medium`, `high`, and `xhigh`, plus `none` only when 9Router advertises `thinkingCanDisable`. Models that do not advertise reasoning receive no reasoning variants.

The plugin copies `context_length` and `max_completion_tokens` from 9Router's live model response into OpenCode's context and output limits, falling back to the equivalent capability fields when needed. Unknown pricing and other metadata remain at the SDK's defaults rather than being invented.

## Security boundaries

- Only `http:` and `https:` base URLs ending in `/v1` are accepted.
- Embedded URL credentials, query strings, fragments, and redirects are rejected.
- Discovery is limited to 1 MiB and five seconds; payloads beyond 1,000 models register the first 1,000 with a warning.
- Model IDs with surrounding whitespace, control characters, or excessive length are ignored.
- Response bodies and caught exception text are never logged.

## Development

```sh
npm test
npm run typecheck
npm run coverage
npm pack --dry-run
```

The package ships its TypeScript source entrypoint directly to OpenCode's Bun-based V2 runtime. Development compilation and release checks use explicit script names so installing the Git dependency does not execute package lifecycle scripts.

Do not publish from an unverified OpenCode beta build. Run `npm run release:check` before publishing.
