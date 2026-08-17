# DeepSeek Harness integration (WIP)

Status: experimental Draft integration, validated against fork commit
`559cd23cc2f1b96da2fde230064da2dc3781b126` on 2026-08-17.

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
3. exposes only that turn's HomeRail DAG tools through a temporary stdio MCP
   proxy, under DSH names such as `mcp__homerail__handoff`;
4. maps DSH text, reasoning, tool, usage, and turn events back to HomeRail; and
5. closes the child, bridge, temporary proxy, and session directory when the
   turn ends.

The child receives the same sanitized environment used by other agent
backends. Manager/Worker control-plane tokens are removed, the external model
credential is supplied only to DSH, and bridge credentials are scoped to the
turn. The DSH composition mounts no shell, filesystem, Skill, runtime-context,
or job tools. Claude, Codex, and Kimi adapters keep their existing registry
entries and code paths.

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
- HomeRail rejects exact `allowed_builtin_tools` assertions for DSH. The WIP
  composition instead disables all DSH built-ins and exposes only HomeRail MCP
  tools.
- DSH is not yet a complete Claude Code replacement in HomeRail: persistent
  sessions, full Manager Agent product integration, image-size optimization,
  and longer live reliability runs remain follow-up work.

## Validation

The adapter unit tests cover event mapping, sanitized child environments,
live steering, and cooperative cancellation. A keyless integration smoke uses
the actual fork runtime and MCP client with a local OpenAI-compatible SSE
server. It verifies that the first model request contains
`mcp__homerail__handoff`, DSH invokes the HomeRail handler with structured
arguments, and a second model request completes with mapped text and usage.
