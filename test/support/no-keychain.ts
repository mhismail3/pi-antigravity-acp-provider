import { vi } from "vitest";

import { SECURITY_CLI } from "../../src/acp/antigravity.js";

// Tests never touch the developer's real Keychain: `security` reports every item absent
// unless a test injects its own probe or mock.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: vi.fn((command: string, ...rest: unknown[]) => {
			if (command === SECURITY_CLI) throw Object.assign(new Error("test keychain"), { status: 44 });
			return (actual.execFileSync as (...args: unknown[]) => unknown)(command, ...rest);
		}),
	};
});
