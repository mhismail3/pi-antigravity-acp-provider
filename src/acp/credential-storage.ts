import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { inspectAntigravityAuth, resolveAntigravityAcpDirectory } from "./antigravity.js";

/** Selects the Antigravity ACP server's secure-file credential backend
 * (`credential_store.py`: `AGY_ACP_FORCE_FILE_STORAGE`). */
export const FORCE_FILE_STORAGE_ENV = "AGY_ACP_FORCE_FILE_STORAGE";

/** macOS keychain coordinates of the server's consumer (CCPA) credential:
 * `credential_store.KEYCHAIN_SERVICE` and the consumer `_KEYCHAIN_ACCOUNT`. */
export const KEYCHAIN_SERVICE = "gemini";
export const KEYCHAIN_ACCOUNT = "antigravity-acp";

const SECURITY_CLI = "/usr/bin/security";
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 3_000;

export type CredentialStorageReason =
	| "explicit-override"
	| "not-darwin"
	| "no-refreshable-token-file"
	| "keychain-entry-present"
	| "missing-keychain-entry";

export interface CredentialStorageDecision {
	/** Child environment entries to apply; empty when the server default is safe. */
	env: Record<string, string>;
	reason: CredentialStorageReason;
}

export interface CredentialStorageOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	tokenPath?: string;
	/** Injectable keychain probe for tests; returns whether the entry exists. */
	keychainEntry?: (service: string, account: string) => boolean;
}

export function clearAntigravityCredentials(directory = resolveAntigravityAcpDirectory()): void {
	if (process.platform === "darwin") {
		try {
			execFileSync(SECURITY_CLI, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], {
				timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS,
				stdio: "ignore",
			});
		} catch (error) {
			if ((error as { status?: number }).status !== 44) {
				throw new Error("Could not remove Antigravity credentials from the macOS Keychain");
			}
		}
	}
	fs.rmSync(path.join(directory, "acp_token.json"), { force: true });
	const settingsPath = path.join(directory, "settings.json");
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		if (!(error instanceof SyntaxError)) throw error;
		fs.rmSync(settingsPath, { force: true });
		return;
	}
	delete settings.auth;
	const temporary = `${settingsPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temporary, settingsPath);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function defaultKeychainLookup(service: string, account: string): boolean {
	try {
		execFileSync(SECURITY_CLI, ["find-generic-password", "-s", service, "-a", account], {
			timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS,
			stdio: "ignore",
		});
		return true;
	} catch {
		// Absent, locked, or denied: treat the entry as unavailable.
		return false;
	}
}

/** The server prefers the login keychain on macOS and falls back to the secure
 * file only when that keychain is unusable. A plaintext token file that the
 * keychain does not mirror is therefore invisible to the server: every new
 * server process reports "Credentials missing or invalid", runs interactive
 * Google consent, and can exceed the session-setup deadline. Pin the server to
 * the backend this provider inspects only in that specific mismatch.
 *
 * `options.env` is the environment of the child the decision applies to, which
 * can differ from this process's; the token file and API key are read from it. */
export function resolveCredentialStorageDecision(
	options: CredentialStorageOptions = {},
): CredentialStorageDecision {
	const env = options.env ?? process.env;
	if (env[FORCE_FILE_STORAGE_ENV]?.trim()) return { env: {}, reason: "explicit-override" };

	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return { env: {}, reason: "not-darwin" };

	const tokenPath = options.tokenPath ?? path.join(resolveAntigravityAcpDirectory(env), "acp_token.json");
	if (inspectAntigravityAuth(path.dirname(tokenPath), env).status !== "oauth-refreshable") {
		return { env: {}, reason: "no-refreshable-token-file" };
	}

	const lookup = options.keychainEntry ?? defaultKeychainLookup;
	if (lookup(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)) return { env: {}, reason: "keychain-entry-present" };

	return {
		env: { [FORCE_FILE_STORAGE_ENV]: "1" },
		reason: "missing-keychain-entry",
	};
}

/** Applies the decision without mutating `baseEnv`, mirroring the other
 * child-only environment adapters. `baseEnv` is the environment the child
 * receives, so the decision inspects that same environment. */
export function applyCredentialStorageEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	options: Omit<CredentialStorageOptions, "env"> = {},
): NodeJS.ProcessEnv {
	const decision = resolveCredentialStorageDecision({ ...options, env: baseEnv });
	return { ...baseEnv, ...decision.env };
}

/** Describes the backend the next child process is expected to use, for
 * `doctor`/`status` diagnostics. This is a preflight selection inferred from
 * the inspected store, not the backend of a running process: the server's own
 * functional keychain probe can still fall back to the file store. */
export function describeCredentialStorage(options: CredentialStorageOptions = {}): string {
	const decision = resolveCredentialStorageDecision(options);
	switch (decision.reason) {
		case "missing-keychain-entry":
			return `secure file (expected: keychain entry ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT} is absent, so spawned server processes are pinned with ${FORCE_FILE_STORAGE_ENV}=1)`;
		case "keychain-entry-present":
			return `macOS keychain (expected: keychain entry ${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT} is present)`;
		case "explicit-override":
			return `${FORCE_FILE_STORAGE_ENV} set by the user`;
		case "no-refreshable-token-file":
			return "server default (expected: no refreshable token file to reuse)";
		default:
			return "server default (secure file)";
	}
}
