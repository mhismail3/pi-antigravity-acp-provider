# Proposed architecture

Status: **proposed**, to be validated by Milestone 0 against the exact bundled CLI.

## 1. Design principles

1. **Pi-facing and ACP-facing state machines are separate.** The event mapper is the only translation layer.
2. **One owner of conversation history.** Track what the live ACP session has seen.
3. **Capabilities are earned, not assumed.** Advertise only implemented ACP client features and gate optional behavior on handshake responses.
4. **Every async resource has one owner and one teardown path.** Processes, RPCs, timers, permission requests, MCP calls, and listeners are generation-scoped.
5. **Safe failure beats transparent magic.** Deny permission, reconstruct context, or restart rather than guess.
6. **Bundle public entry points; never import Gemini internals.** The child process is the compatibility boundary.

## 2. Proposed repository/module layout

```text
extensions/
  index.ts                    # minimal Pi registration + lifecycle wiring
src/
  provider.ts                 # complete pi-ai Provider factory
  models.ts                   # live ACP model projection + reference rates
  auth.ts                     # Pi /login adapter to ACP authenticate
  stream/
    stream.ts                 # required Provider.stream adapter; delegates to shared coordinator
    stream-simple.ts          # Pi call coordinator used by both provider entry points
    pi-events.ts              # balanced content-block writer
    context.ts                # latest input, reconstruction, delta/watermark
    usage.ts                  # quota parser and cost policy
  acp/
    driver.ts                 # typed turn API, queues, prompt continuation
    connection.ts             # official SDK adapter + request deadlines
    process.ts                # bundled entry resolution/spawn/kill tree
    events.ts                 # SessionUpdate -> typed activities
    capabilities.ts           # negotiated feature helpers
    errors.ts                 # redacted typed failures
  sessions/
    manager.ts                # Pi session bindings and process generations
    store.ts                  # optional atomic binding metadata cache
  permissions/
    broker.ts                 # parked permission requests
    tool.ts                   # registered Pi confirmation tool
    policy.ts                 # explicit headless/session policy
  mcp/                        # required for Pi/marketplace tool interoperability before 1.0
    server.ts                 # expose active compatible Pi tools
    round-trips.ts            # parked Pi tool execution
  diagnostics/
    command.ts                # /gemini-acp doctor/status
    snapshot.ts               # redacted runtime state
  lifecycle.ts                # one idempotent shutdown coordinator
test/
  fake-agent.ts               # programmable ACP subprocess
  fixtures/                   # captured/redacted protocol frames
  integration/                # bundled real CLI tests
scripts/
  smoke-packed.mjs            # install tarball into isolated PI_CODING_AGENT_DIR
```

The extension entry must contain no transport or protocol logic. It creates one runtime, registers the provider and permission/diagnostic command, and hooks `session_shutdown`/reload disposal.

## 3. Runtime component model

### Provider

A complete provider has:

- id `antigravity-acp`, name `Google Antigravity`;
- ambient/API-key auth adapter;
- an initially empty catalog and explicitly unverified cached discovery for offline startup;
- `refreshModels` that publishes the authenticated live ACP inventory, including an empty result;
- discovery through each base model’s own returned thinking selector, without a static catalog or cross-model effort guesses;
- shared `stream`/`streamSimple` implementation;
- no network `baseUrl` because requests go to a local child.

The API id is `antigravity-acp`. Names and selector values come from ACP. Pi groups advertised effort variants in its thinking map. Selection uses only confirmed live configuration selectors; unsupported selections do not fall back to `session/set_model`. Hosts must explicitly allow a network refresh after sign-in or an account change. Disposable discovery sessions never prompt and are removed after their processes exit.

### Runtime/session manager

The manager owns processes and bindings:

```ts
interface Binding {
  piSessionId: string;
  cwd: string;
  processGeneration: number;
  acpSessionId: string;
  effectiveModelId: string;
  modeId?: string;
  messageWatermark: number;
  prefixFingerprint: string;
  initializedContextHash?: string;
  state: "idle" | "prompting" | "awaiting-permission" | "dead";
}
```

A binding queue serializes user prompts and continuations. Never key solely by cwd. If Pi omits `sessionId` or sends `cacheRetention: "none"` (a one-off request such as a compaction summary), create an ephemeral binding scoped to the runtime call chain; do not share arbitrary conversations by cwd.

The v1 implementation uses one process per active binding for isolation and simple cancellation. Catalog discovery uses a separate process that closes after publication. A later measured optimization may multiplex sessions only if Gemini CLI demonstrates correct concurrent routing. A bounded pool (for example 2–4 live binding processes) and idle eviction prevents unbounded growth.

### ACP process/connection

Resolve the installed package entry once using ESM module resolution. Launch through a small packaged supervisor/watchdog rather than detaching Gemini directly:

```text
command: process.execPath
args: [resolvedSupervisorEntry, resolvedGeminiEntry, "--acp"]
stdio: ["pipe", "pipe", "pipe"]
shell: false
windowsHide: true
detached: true on POSIX only for a dedicated killable process group
```

The supervisor transparently forwards ACP stdio, spawns Gemini without a shell, records the original Pi parent PID/IPC channel, and kills its whole child group if Pi disappears. Normal teardown signals the dedicated group. On Windows use a tested Job Object/tree-kill implementation. Do not rely solely on ACP stdin EOF: a hung agent or descriptor-inheriting grandchild may prevent it. Packed smoke tests must kill the Pi-side parent abruptly and verify the watchdog, agent, and tool grandchildren disappear. If a reliable watchdog/tree strategy is unavailable on a platform, that platform is unsupported rather than knowingly leaking detached processes.

Attach `error`, `exit`, and stream listeners before awaiting anything. Keep stdout exclusively for ACP frames and stderr as a bounded, redacted diagnostic ring. The SDK adapter owns one connection and all in-flight RPC promises.

Recommended deadlines (configuration may tune within safe bounds):

| Operation | Initial default |
|---|---:|
| Spawn + initialize | 30 s |
| Authenticate | 180 s; user interaction aware |
| Session new/model/mode | 30 s |
| Prompt idle | 120 s excluding active permission UI |
| Prompt overall | 10 min |
| Cancel grace | 1.5 s |
| SIGTERM → SIGKILL | 1 s |
| Idle process TTL | 10 min |

All deadline timers use `unref` where possible. User login and permission UI have explicit cancellation rather than an invisible fixed wall clock. While `binding.state === "awaiting-permission"`, pause prompt-idle and process-idle eviction timers; retain only the permission expiry and overall safety deadline. A late permission result for a dead generation is handled as a normal denied/failed continuation, never an unhandled rejection.

## 4. Startup and model publication

Do not spawn during extension load. `getModels()` starts empty. Offline refresh may restore only the last discovered inventory, marked “cached; access unverified”; it does not invent model IDs or thinking tiers.

On an explicit network-enabled model refresh:

1. Acquire/start a catalog process.
2. Initialize and authenticate using the effective provider credential/native Antigravity store.
3. Create a disposable session rooted at the current/project cwd.
4. Require the stable model selector, select each advertised base and read its own returned thinking options.
5. Validate ids/names and project into Pi models.
6. Publish and persist the authoritative catalog with its check timestamp; a successful empty result clears stale entries.
7. Close the dedicated process and remove its disposable conversation after exit; never bind discovery to chat.

If refresh fails, retain previously discovered data and surface the error. No static catalog or model-selection fallback replaces failed discovery.

## 5. Turn flow

### New/fresh binding

```text
Pi streamSimple
  ├─ validate cwd, session id, latest input
  ├─ get/create process; initialize/authenticate
  ├─ start/refresh authenticated loopback MCP bridge for active Pi tools
  ├─ session/new(cwd, mcpServers=[piBridgeDescriptor])
  ├─ require stable model configuration; set model if currentModelId differs
  ├─ build one-time reconstruction resource
  ├─ session/prompt([images, reconstruction resource, latest text])
  ├─ map concurrent updates to Pi events
  ├─ parse PromptResponse usage/stop
  └─ commit binding watermark; emit terminal event
```

The one-time reconstruction contains Pi's system prompt, prior messages needed for continuity, and a clear data boundary. It must not instruct Gemini to replay previous tool actions. It excludes the current user content, which remains the final prompt block.

### Warm binding

Validate the context prefix fingerprint/watermark. Build only a delta of messages added since the binding last committed that Gemini could not have observed (other-provider outputs, Pi tool results, compaction summary). Send the current user message once. Prior Gemini assistant text does not need replay.

Commit the new watermark only after a completed turn. On abort/error, preserve enough state to determine whether recovery/reconstruction is required rather than assuming the session saw nothing.

### Native tool display

Antigravity runs its own tools inside the ACP prompt. Each `tool_call` becomes a Pi `toolCall` of the registered display-only `antigravity_tool` (arguments: the one-line title, plus `command`, `path`, `query` or `url` mapped from the ACP kind, `rawInput` and first location) in the same assistant message; `tool_call_update`s update the runtime's record of its status and bounded output. Calls titled `pi-bridge_…` are bridged Pi tools and already have their own Pi calls, so they are skipped.

The turn still ends with Antigravity's stop reason. Pi then runs the display tool, which returns the recorded state once, never executes anything, and sets `terminate`, so a batch of only display calls ends without another provider request. If Pi asks anyway (a blocked call or a `length` stop), the provider answers an empty `stop` without prompting Antigravity. The tool's declaration is hidden from the model through `prepareLoadout`, it is excluded from the MCP bridge, and its calls and results are left out of context reconstruction because Antigravity already holds them.

When the user cancels, the response ends aborted and Pi runs none of its calls. Tron's Pi patch then asks the display tool's `settleAborted` for each call: a call Antigravity reported completed or failed records that outcome; a call still running gets no result, so it shows as interrupted, not failed.

### Permission continuation

When Gemini sends `session/request_permission`:

1. The ACP request stays pending in `PermissionBroker`.
2. Close any open Pi text/thinking block.
3. Emit a Pi `toolCall` for the registered `gemini_acp_permission` tool and terminate this Pi stream with `toolUse`.
4. Pi executes the permission tool, which shows/selects the choices and returns a machine-readable selection.
5. Pi invokes the provider again with that `toolResult` in context.
6. Find the parked request by an unguessable call id, verify session/generation, resolve it with the offered ACP option id, and resume reading the same ACP prompt—do **not** send another `session/prompt`.
7. Continue until the Gemini prompt ends or another round trip is required.

The binding's overall prompt deadline pauses only while Pi is actively collecting user permission. Abort resolves the ACP permission with `cancelled` and tears down as needed.

A provider restart cannot resume a parked request. Fail the turn clearly and reconstruct on the next user turn.

## 6. Context reconstruction algorithm

Store `messageWatermark` and a fingerprint of normalized message identities/content up to that point.

On each non-continuation call:

1. Identify current user input. If the tail is a provider-owned permission result, use continuation handling instead.
2. If context length is at least the watermark and prefix fingerprint matches, binding is warm.
3. If it does not match (branch, rewind, compaction, session restore, cross-process recovery), destroy the old ACP binding and reconstruct. ACP history cannot be edited or compacted retroactively.
4. For warm binding, collect external messages between watermark and current input, excluding this provider's assistant messages and internal permission bookkeeping.
5. For fresh binding, collect the latest Pi system prompt, latest compaction summary, and a bounded chronological transcript. Clearly label roles/providers/tool results.
6. Truncate by bytes/tokens, preserving system instructions, latest compaction summary, and newest messages. Add `[truncated]`; never cut Unicode code points.
7. Prefer ACP embedded `resource`; if not advertised, use a delimited text preamble.
8. Place images/resources before final user text.

Security framing should say the reconstructed transcript is untrusted conversation data, not higher-priority system policy. Pi's actual system prompt should be in a separately labeled section; ACP v1 does not provide a true system role, so this limitation is documented.

## 7. Process crash and session recovery

On unexpected exit:

- atomically mark all bindings on that generation dead;
- reject pending RPCs and permission/MCP brokers;
- suppress late events by checking generation;
- keep redacted exit code/signal/stderr tail;
- do not restart in a tight loop.

Next user request gets a fresh process/session and one-time Pi context reconstruction. This is the default reliable recovery path.

Optional cross-process load algorithm, initially disabled:

1. Persist `{piSessionId, acpSessionId, cwd, cliVersion, updatedAt}` atomically with mode 0600.
2. On compatible CLI version, run a canary-safe `session/load` with replay suppression.
3. Verify a sentinel/memory condition before trusting it.
4. On any failure or known vulnerable version, abandon load and reconstruct; never retry load repeatedly against the same upstream record.

Given open destructive load reports, shipping reconstruction first is a deliberate correctness choice.

## 8. Model switching

Before a fresh or restored binding can prompt, require stable model configuration even when the session's reported model already matches the request. Compare the requested model with the confirmed session selection:

- if equal: retain the confirmed selection;
- if advertised and different: use `session/set_config_option` to confirm the base model, then validate and confirm its fresh thinking selector;
- if configuration is missing, unavailable or unconfirmed: return a precise model error and do not prompt on a stale model;
- never use a draft model method or silently continue on the old model.

Store `responseModel` from per-model usage/current updates where possible. Pi model selection and Gemini's auto-router can differ; diagnostics should make that visible.

## 9. Tool topology

### v1: Gemini-native loop

Gemini keeps core tools. ACP tool updates are display events, not Pi-executable calls. Permission requests use Pi's round trip. This avoids duplicate edits and avoids mutating user Gemini settings.

### 1.0 target: Pi tools over MCP

To satisfy first-class Pi tool and marketplace-extension compatibility, an in-process localhost MCP server advertises the active compatible `Context.tools` (excluding provider-internal tools) under an unambiguous `pi_` namespace. Start it before `session/new` and include its descriptor at session creation; update its `tools/list` view from the current Pi context. Sanitize TypeBox schemas to Gemini's accepted function-schema subset and omit incompatible tools with bounded diagnostics rather than causing a model API 400.

Gemini core tools may coexist. The reconstruction/system instructions direct Gemini to prefer `pi_` workspace tools when an equivalent exists, but prose cannot enforce routing. The security boundary must be explicit: Pi `tool_call` hooks and marketplace policies govern bridged Pi tools only; Gemini-native tools execute in the child and are governed by Gemini's permission/policy system plus the ACP permission broker. M0 must probe a per-process, non-persistent policy for excluding overlapping native tools. Use it only when it preserves MCP visibility and never mutate global Gemini settings. If no safe exclusion exists, ship the dual-loop boundary prominently documented. If the bridge itself is not ready, releases remain beta.

The MCP server parks calls rather than executing them internally. Requirements:

- unguessable bearer token and loopback binding;
- schemas converted losslessly or tools omitted;
- tool list refreshed per turn;
- no credentials exposed to Gemini;
- per-call timeout/abort/generation checks;
- explicit collision policy with Gemini core tool names;
- no `tools.core: []` workaround because of upstream #28361;
- compatibility tests proving Pi marketplace tools remain visible and execute through Pi;
- the provider-owned permission broker tool is never advertised back through MCP, preventing recursion.

Do not execute Pi tool implementations directly from provider internals; that would bypass Pi hooks, rendering, policy, and transcript handling.

## 10. State persistence

Only non-secret metadata may be stored under Pi's data directory:

```text
~/.pi/agent/pi-gemini-acp-provider/
  models-v1.json       # validated ACP catalog + version/timestamp
  sessions-v1.json     # optional load bindings; 0600, atomic rename
  debug/               # opt-in redacted logs with retention cap
```

Google OAuth credentials stay in Gemini CLI's store. API keys should use Pi auth storage and be injected over ACP, not written to this directory. Never persist prompt text, file content, permission diffs, stderr wholesale, or MCP bearer tokens.

## 11. Shutdown ownership

A top-level `Runtime.dispose(reason)` is idempotent:

1. reject new work;
2. cancel/deny permission and MCP requests;
3. send session cancel for active prompts;
4. close SDK transports/stdin;
5. kill remaining process groups with escalation;
6. close local MCP server;
7. clear timers/listeners/maps;
8. await all teardown promises with a bounded deadline.

Call it on Pi `session_shutdown`, extension unload/reload if exposed, process fatal conditions, and test teardown. Individual idle evictions use the same lower-level connection close path.

## 12. Architecture invariants to assert in tests

- A process generation cannot emit into a successor's stream.
- One ACP notification belongs to exactly one session/turn.
- One Pi session never shares history with another by cwd accident.
- One current user message produces at most one ACP prompt request.
- A permission result resolves only its original pending request.
- A completed Gemini tool is never executed again merely for display.
- Every open Pi block closes before switch/terminal.
- Every pending promise settles on abort/exit/dispose.
- Model id is set before prompt and never silently stale.
- Binding watermark advances only after a known terminal outcome.
