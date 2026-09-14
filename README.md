# opencode-9router-v2

Unofficial native OpenCode V2 plugin that discovers models from a private 9Router OpenAI-compatible gateway. It was built against `opencode2 v0.0.0-beta-19425` and `@opencode-ai/plugin 0.0.0-next-17444`.

OpenCode V2 is still a preview. Re-check the plugin SDK contract before upgrading either pinned beta dependency.

## What it does

- Reads `OPENCODE_9ROUTER_URL` and `OPENCODE_9ROUTER_API_KEY`.
- Falls back per missing variable to `~/.config/environment.d/9router.conf`.
- Calls `GET <baseURL>/models` once at plugin setup with Bearer authentication.
- Registers provider `9router` as `9Router` and preserves upstream IDs exactly.
- Exposes OpenCode reasoning variants for models whose live 9Router metadata advertises reasoning.
- Routes each model through `@ai-sdk/openai-compatible` using the configured `/v1` base URL.
- Warns once and lets OpenCode continue if configuration or discovery fails.

It does not execute commands, scan projects, cache results, or contact metadata services.

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

This is not a V1 config-hook plugin. Its default export is a V2 definition with an `id` and `setup` function from `@opencode-ai/plugin`. Setup registers a replayable `catalog.transform`.

The provider sets `package` to `aisdk:@ai-sdk/openai-compatible`. Non-reasoning models keep that package; reasoning models use `@opencode/ai/providers/openai-compatible/responses` so a reasoning gateway does passthrough instead of `openai→openai-responses` translation, which otherwise replays full reasoning paragraphs instead of concise summaries. The `aisdk:` catalog discriminator selects OpenCode's AI SDK resolver, which normalizes the remainder to the official OpenAI-compatible provider package. Provider `settings.baseURL` selects the configured gateway, while `settings.apiKey` is resolved by that transport into `Authorization: Bearer <key>`. Each model's catalog key remains its full discovered route and `modelID` repeats that exact value, which is the identifier sent upstream. These fields are required by the beta-19425 resolver; the older `model.api` shape belongs to a different V2 snapshot.

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
