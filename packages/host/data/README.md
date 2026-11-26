# Model prices

`model-prices.json` holds the official prices, in US dollars per million tokens, that Pier uses to estimate the cost of requests whose agent recorded none. The usage page marks these estimates with “≈”. Hosts sync the file from this repository at most once a day and also bundle the copy they were built with.

The file is generated: the `Model prices` workflow runs `bun run update-prices` every day. The script takes the model vendors' own entries (Anthropic, OpenAI, Google, DeepSeek, ...) from the newest `@earendil-works/pi-ai` model catalog on npm and applies `model-prices.overrides.json`. Models the catalog drops keep their last price. Do not edit `model-prices.json` by hand.

To add or correct a price, add an entry to `model-prices.overrides.json`, run `bun run update-prices` and commit both files:

```json
{
	"models": [
		{ "provider": "openai", "id": "gpt-example", "cost": { "input": 2, "output": 10, "cacheRead": 0.2, "cacheWrite": 0 } },
		{ "provider": "anthropic", "id": "claude-retired", "cost": null }
	]
}
```

- `provider` must be a model vendor whose prices Pier uses (see `PROVIDER_RANK` in `src/pi/model-capabilities.ts`, before `openrouter`).
- `cost` takes `input` and `output`, optionally `cacheRead`, `cacheWrite` (5-minute cache writes) and `tiers`: `[{ "inputTokensAbove": 272000, "input": …, "output": …, "cacheRead": …, "cacheWrite": … }]`. `null` removes the model.
