import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["test/support/isolate-home.ts"],
		setupFiles: ["test/support/no-keychain.ts"],
		testTimeout: 10_000,
	},
});
