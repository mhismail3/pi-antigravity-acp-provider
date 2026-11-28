import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";

export type AcpActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "tool"; start: true; id: string; title: string; input: NativeToolInput; status: string; output: string }
	| { type: "tool"; start: false; id: string; status?: string; output: string }
	| { type: "plan"; text: string }
	| { type: "usage"; used: number }
	| { type: "unknown"; updateType: string };

/** Display arguments of a native tool card: the keys Pi tool cards already show for commands, files, searches and URLs. */
export interface NativeToolInput {
	title: string;
	command?: string;
	path?: string;
	query?: string;
	url?: string;
}

export function mapSessionUpdate(notification: SessionNotification): AcpActivity[] {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return update.content.type === "text"
				? [{ type: "text", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_message:${update.content.type}` }];
		case "agent_thought_chunk":
			return update.content.type === "text"
				? [{ type: "thought", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_thought:${update.content.type}` }];
		case "tool_call": {
			const title = clean(update.title).replace(/\s+/gu, " ").trim() || "tool";
			return [{
				type: "tool",
				start: true,
				id: update.toolCallId,
				title,
				input: nativeToolInput(title, update.kind, update.rawInput, update.locations),
				status: update.status ?? "pending",
				output: toolContentText(update.content),
			}];
		}
		case "tool_call_update":
			return [{
				type: "tool",
				start: false,
				id: update.toolCallId,
				...(update.status ? { status: update.status } : {}),
				output: toolContentText(update.content),
			}];
		case "plan": {
			const lines = update.entries.map((entry) => `- [${entry.status}] ${clean(entry.content)}`);
			return lines.length ? [{ type: "plan", text: `\n[Antigravity plan]\n${lines.join("\n")}\n` }] : [];
		}
		case "usage_update":
			// Sent once per inference with the context size after it; session setup reports 0.
			return update.used > 0 ? [{ type: "usage", used: update.used }] : [];
		default:
			return [{ type: "unknown", updateType: update.sessionUpdate }];
	}
}

/** agy titles an execute call with its command line and reports paths as ACP locations. */
function nativeToolInput(title: string, kind: unknown, rawInput: unknown, locations: unknown): NativeToolInput {
	const raw = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput as Record<string, unknown> : {};
	const field = (...keys: string[]) => {
		for (const key of keys) if (typeof raw[key] === "string" && raw[key].trim()) return clean(raw[key]).trim();
		return undefined;
	};
	const location = Array.isArray(locations) && typeof locations[0]?.path === "string" ? clean(locations[0].path) : undefined;
	const [key, value] = kind === "execute" ? ["command", field("CommandLine", "command_line", "command") ?? title] as const
		: kind === "read" || kind === "edit" || kind === "delete" || kind === "move" ? ["path", location] as const
		: kind === "search" ? ["query", field("Query", "query", "Pattern", "pattern")] as const
		: kind === "fetch" ? ["url", field("Url", "url")] as const
		: [undefined, undefined] as const;
	const input: NativeToolInput = { title };
	if (key && value) input[key] = value;
	return input;
}

function toolContentText(content: SessionNotification["update"] extends infer _T ? unknown : never): string {
	if (!Array.isArray(content)) return "";
	const output: string[] = [];
	for (const item of content.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "diff") {
			const path = typeof record.path === "string" ? clean(record.path) : "file";
			output.push(`[diff: ${path}]`);
		} else if (record.type === "content") {
			const block = record.content as Record<string, unknown> | undefined;
			if (block?.type === "text" && typeof block.text === "string") {
				output.push(clean(block.text).slice(0, 2_000));
			}
		}
	}
	return output.join("\n").slice(0, 4_000);
}

function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, 2_000);
}
