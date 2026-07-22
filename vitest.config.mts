import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
		coverage: {
			provider: "istanbul", // the workers pool does not support the v8 provider
			reporter: ["text", "lcov"],
			include: ["src/**"],
		},
	},
});
