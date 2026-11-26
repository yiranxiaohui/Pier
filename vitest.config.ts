import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"packages/*/test/**/*.test.ts",
			"apps/desktop/test/**/*.test.ts",
			"apps/mobile/test/**/*.test.ts",
			"apps/relay/test/**/*.test.ts",
		],
		testTimeout: 20_000,
		// Hosts started by tests must not fetch the published model prices.
		env: { PIER_MODEL_PRICES_URL: "off" },
	},
});
