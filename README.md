# opencode-9router-v2

Unofficial native OpenCode V2 plugin that discovers models from a private 9Router OpenAI-compatible gateway. It was built against `opencode2 v0.0.0-beta-19425` and `@opencode-ai/plugin 0.0.0-next-17444`.

OpenCode V2 is still a preview. Re-check the plugin SDK contract before upgrading either pinned beta dependency.

## What it does

- Reads `OPENCODE_9ROUTER_URL` and `OPENCODE_9ROUTER_API_KEY`.
- Falls back per missing variable to `~/.config/environment.d/9router.conf`.
- Calls `GET <baseURL>/models` once at plugin setup with Bearer authentication.
- Registers provider `9router` as `9Router` and preserves upstream IDs exactly.
- Routes each model through `@ai-sdk/openai-compatible` using the configured `/v1` base URL.
- Warns once and lets OpenCode continue if configuration or discovery fails.

It does not execute commands, scan projects, cache results, or contact metadata services.

## Configure

The URL must end in `/v1`:

```sh
export OPENCODE_9ROUTER_URL="http://10.0.0.1:20128/v1"
export OPENCODE_9ROUTER_API_KEY="your-key"
```

On Linux, the plugin can instead read:

```ini
# ~/.config/environment.d/9router.conf
OPENCODE_9ROUTER_URL=http://10.0.0.1:20128/v1
OPENCODE_9ROUTER_API_KEY=your-key
```

Environment variables override file values. Protect the file with `chmod 600 ~/.config/environment.d/9router.conf` and restart OpenCode after changing configuration.

## Develop locally

```sh
git clone <your-repository-url> opencode-9router-v2
cd opencode-9router-v2
npm ci
npm run test
npm run build
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

In the TUI, `/models` should show provider `9Router` and names such as `Muse Spark 1.3 Contributor`.

For a tool round trip, ask the selected model to use a harmless built-in tool, such as listing the current directory, and confirm the tool result is incorporated into its answer.

## Uninstall

Remove the same Git package specifier used for installation:

```sh
opencode2 plugin remove git+https://github.com/Jordonbc/opencode-v2-9router.git
```

Then restart OpenCode. Removing the plugin does not modify `~/.config/environment.d/9router.conf`.

## Why these V2 fields matter

This is not a V1 config-hook plugin. Its default export is a V2 definition with an `id` and `setup` function from `@opencode-ai/plugin`. Setup registers a replayable `catalog.transform`.

The provider and every discovered model set `package` to `aisdk:@ai-sdk/openai-compatible`. The `aisdk:` catalog discriminator selects OpenCode's AI SDK resolver, which normalizes the remainder to the official OpenAI-compatible provider package. Provider `settings.baseURL` selects the configured gateway, while `settings.apiKey` is resolved by that transport into `Authorization: Bearer <key>`. Each model's catalog key remains its full discovered route and `modelID` repeats that exact value, which is the identifier sent upstream. These fields are required by the beta-19425 resolver; the older `model.api` shape belongs to a different V2 snapshot.

Unknown context limits, pricing, reasoning, and modality metadata are left at the SDK's defaults rather than invented.

## Security boundaries

- Only `http:` and `https:` base URLs ending in `/v1` are accepted.
- Embedded URL credentials, query strings, fragments, and redirects are rejected.
- Discovery is limited to 1 MiB, 1,000 models, and five seconds.
- Model IDs with surrounding whitespace, control characters, or excessive length are ignored.
- Response bodies and caught exception text are never logged.

## Development

```sh
npm test
npm run typecheck
npm pack --dry-run
```

Do not publish from an unverified OpenCode beta build.
