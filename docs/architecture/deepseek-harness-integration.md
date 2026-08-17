# DeepSeek Harness integration (WIP)

Status: experimental Draft integration, validated against fork commit
`ec75587a05bf0cc3f29dd0d5f875d3235f7deae6` on 2026-08-17.

HomeRail uses the owner-maintained
[`xiaotianfotos/deepseek-harness`](https://github.com/xiaotianfotos/deepseek-harness)
fork. The integration branch is `agent/homerail-sdk-control`; its base is a
shallow clone of the official repository. The fork carries the HomeRail
composition, SDK steering and cancellation requests, and an initialization
barrier that prevents a first prompt from racing asynchronous MCP discovery.

## Runtime boundary

`deepseek_harness` is an independent Worker backend. For each HomeRail turn it:

1. starts a dedicated DSH JSON-RPC child process through the published
   `@deepseek-ai/dsh-sdk-client` transport;
2. starts a loopback-only HTTP bridge protected by a random bearer token;
3. exposes that turn's HomeRail DAG tools and, when the DAG explicitly requests
   them, HomeRail-managed `Read`, `Grep`, `Glob`, and `LS` implementations
   through a temporary stdio MCP proxy, under DSH names such as
   `mcp__homerail__handoff`;
4. maps DSH text, reasoning, tool, usage, and turn events back to HomeRail; and
5. closes the child, bridge, temporary proxy, and session directory when the
   turn ends.

Each DSH conversation-model request is capped at 32,768 output tokens by
default, leaving room in large context windows for the prompt and accumulated
tool transcript. Operators can set `HOMERAIL_DSH_MAX_TOKENS` to another
positive integer when a model requires a tighter limit.

The HomeRail Cordis composition reads `DSH_REASONING_EFFORT`, using `high` when
the caller does not select an effort. The pinned fork's native
chat-completions adapter passes `low`, `medium`, `high`, `xhigh`, and `max`
through unchanged; `off` disables thinking. This lets a runtime profile tune
the local Qwen endpoint without changing the official DeepSeek default.

The child receives the same sanitized environment used by other agent
backends. Manager/Worker control-plane tokens are removed, the external model
credential is supplied only to DSH, and bridge credentials are scoped to the
turn. The DSH composition itself mounts no shell, filesystem, Skill,
runtime-context, or job tools. Read-only filesystem calls are implemented by
the Worker bridge, confined to the DAG's declared `workspace_access` roots,
bounded for input/output size, optionally bounded by an explicit workflow call
limit, and protected against traversal and symlink escapes. Claude, Codex, and
Kimi adapters keep their existing registry entries and code paths.

## Runtime packaging and source checkout setup

The standard Worker image builds the pinned fork in an isolated Docker stage,
materializes its symlink-free Node deploy closure, and copies only that closure
into `/opt/deepseek-harness-runtime`. It also sets the runtime command,
arguments, and HomeRail Cordis config in the image, so ordinary DAG containers
need no DSH-specific host setup. Changing the fork revision is an intentional
Dockerfile change and therefore changes the Worker source fingerprint.

For host-shell Manager Agent development, build the same pinned fork checkout:

```bash
git clone --depth 1 --branch agent/homerail-sdk-control \
  https://github.com/xiaotianfotos/deepseek-harness.git
cd deepseek-harness
corepack pnpm install --frozen-lockfile
corepack pnpm run build:lib:host
corepack pnpm exec tsx scripts/build-exe-for-python-sdk.ts --skip-build --node-only
```

Point the Worker at the fork's generic runtime and HomeRail composition. Values
must be absolute paths; runtime arguments are a JSON string array.

```bash
export HOMERAIL_DSH_RUNTIME_COMMAND=/usr/bin/node
export HOMERAIL_DSH_RUNTIME_ARGS='["/absolute/path/deepseek-harness/python/sdk-runtime/src/deepseek_harness_runtime/runtime/node/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js"]'
export HOMERAIL_DSH_CORDIS_CONFIG=/absolute/path/homerail/homerail_worker/dsh/homerail.cordis.yml
```

Select `deepseek_harness` (aliases `dsh`, `deepseek`, and `deepseek-harness`
are accepted) and an active HomeRail model setting whose protocol is
`openai_compatible`. Both Manager Agent host-shell placement and DAG container
placement resolve through the same runtime contract. A missing fork runtime,
invalid runtime-argument JSON, or non-OpenAI-compatible endpoint fails instead
of falling back to another harness.

## Control protocol

The adapter uses ordinary `initialize`, `session/prompt`, and session event
notifications from the released TypeScript SDK. It subscribes before sending
the prompt, then binds HomeRail's turn controller as soon as the prompt receipt
arrives, so queued steering and cancellation do not race the first model step.
The fork extends the generic JSON-RPC client with two independent requests:

- `session/steer` queues a user message for the nearest later agent step and
  returns its durable `messageId`;
- `session/cancel` requests cooperative cancellation of a running session and
  returns whether it was accepted.

HomeRail binds these requests to its turn controller, so live steering and
interrupts do not require Claude-specific protocol emulation.

## Current limitations

- The adapter deliberately starts one DSH process per turn. Persistent DSH
  session resume and reuse across turns are not implemented.
- The standard UI and onboarding flow do not yet offer DSH as a polished
  selection; the protocol, runtime resolver, CLI doctor, and Worker backend are
  present for manual/WIP use.
- DSH accepts exact `allowed_builtin_tools` only for `Read`, `Grep`, `Glob`, and
  `LS`. Shell and mutation tools remain unsupported and fail closed. These
  four names are HomeRail-managed MCP implementations, not DSH-native
  filesystem plugins.
- HomeRail passes the runtime profile's DSH reasoning effort through to the
  fork. Other DSH callers retain the fork's `high` default; the local-Qwen PR
  Review profile defaults to `medium` so three concurrent reviewers do not
  repeatedly fill their histories with `xhigh` reasoning.
- DSH-managed read/search tools enforce a call budget only when the workflow
  explicitly sets `max_builtin_tool_calls`. HomeRail does not impose a DSH
  default merely to compensate for one model's late handoff behavior. The
  handoff tool remains outside any explicitly selected read/search budget.
- DSH is not yet a complete Claude Code replacement in HomeRail: persistent
  sessions, full Manager Agent product integration, image-size optimization,
  and longer live reliability runs remain follow-up work.

## Validation

The adapter unit tests cover event mapping, sanitized child environments,
workspace-confined read/search tools, tool budgets, live steering, and
cooperative cancellation. A keyless integration smoke uses
the actual fork runtime and MCP client with a local OpenAI-compatible SSE
server. It verifies that the first model request contains
`mcp__homerail__handoff`, DSH invokes the HomeRail handler with structured
arguments, and a second model request completes with mapped text and usage.

The 2026-08-17 FP8 live test used the existing three-reviewer PR Review DAG,
three independent DSH processes, and the same local Qwen3.8 27B model setting
for all historical reviewer labels. The unbounded `xhigh` run
([Actions](https://github.com/xiaotianfotos/homerail/actions/runs/32023994801),
HomeRail run `d40c93aa-d9ff-4b57-a97c-e1c98c8d3e14`) reached the stable
runner's 70-minute limit. One reviewer completed through a correction turn;
the other two were still inspecting after 32 and 37 tool calls. The model
service reported no request errors, but the three long contexts drove KV use
to 93--99.7 percent and caused 18 preemptions.

That run processed about 8.16 million prompt tokens: about 4.96 million were
local prefix-cache hits and 3.20 million were recomputed. Cache therefore
worked, but it could not accelerate roughly 166,000 generated tokens, new tool
results appended after each exact cached prefix, or private session tails
evicted under concurrent KV pressure. No DSH compaction plugin was mounted and
the transcripts contained no compaction event. The observed prefill was normal
multi-turn reconstruction and cache eviction, not conversation compression.
