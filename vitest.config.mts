import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	test: {
		coverage: {
			provider: "istanbul", // the workers pool does not support the v8 provider
			reporter: ["text", "lcov"],
			include: ["src/**"],
		},
	},
});
