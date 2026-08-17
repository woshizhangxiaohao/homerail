import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessAdapter, _deepSeekHarnessForkCommitForTest } from "../agent/deepseek-harness.js";
import { AgentTurnController } from "../agent/turn-controller.js";
import type { AgentEvent, AgentRunContext } from "../agent/types.js";

const fakeRuntime = fileURLToPath(new URL("./fixtures/fake-dsh-runtime.mjs", import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "homerail-dsh-test-"));
  tempRoots.push(root);
  return root;
}

function context(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    provider: "deepseek",
    protocol: "openai_compatible",
    model: "test-model",
    apiKey: "test-secret",
    baseUrl: "https://example.invalid/v1/chat/completions/",
    workspace: process.cwd(),
    sessionId: "session-under-test",
    ...overrides,
  };
}

async function collect(adapter: DeepSeekHarnessAdapter, runContext: AgentRunContext): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of adapter.run("do the work", [], runContext)) events.push(event);
  return events;
}

describe("DeepSeekHarnessAdapter", () => {
  it("maps DSH streaming, tool, usage, and completion events without leaking the Manager token", async () => {
    const root = tempRoot();
    const recordFile = join(root, "runtime.jsonl");
    const customConfig = join(root, "fork-homerail.cordis.yml");
    vi.stubEnv("HOMERAIL_WORKER_TOKEN", "manager-secret");
    vi.stubEnv("HOMERAIL_DSH_CORDIS_CONFIG", customConfig);
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const events = await collect(adapter, context({
      environmentVariables: {
        DSH_FAKE_RECORD_FILE: recordFile,
        HOMERAIL_WORKER_TOKEN: "context-manager-secret",
      },
    }));

    expect(events).toContainEqual({ type: "thinking", text: "checking" });
    expect(events).toContainEqual({ type: "text", text: "finished" });
    expect(events).toContainEqual({
      type: "tool_use",
      id: "call-1",
      name: "handoff",
      input: { port: "done", content: "ok" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      content: "accepted",
      is_error: false,
    });
    expect(events).toContainEqual({
      type: "usage",
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", finish_reason: "completed" });
    expect(_deepSeekHarnessForkCommitForTest).toMatch(/^[a-f0-9]{40}$/);

    const recorded = JSON.parse(readFileSync(recordFile, "utf8").trim()) as Record<string, unknown>;
    expect(recorded.managerToken).toBeUndefined();
    expect(recorded.baseUrl).toBe("https://example.invalid/v1");
    expect(recorded.cordisConfig).toBe(customConfig);
  });

  it("routes queued live steering through the fork session/steer method", async () => {
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const eventsPromise = collect(adapter, context({
      turnController: controller,
      environmentVariables: { DSH_FAKE_WAIT_FOR: "steer" },
    }));
    const receipt = controller.steer({ commandId: "redirect", content: "change direction" });
    expect(receipt.status).toBe("accepted");
    if (receipt.status !== "accepted") throw new Error("steer was not accepted");

    await expect(receipt.accepted).resolves.toEqual({ status: "accepted" });
    await expect(receipt.applied).resolves.toEqual({ status: "applied" });
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("done");
    await controller.close({ outcome: "completed" });
  });

  it("projects only the explicitly allowed HomeRail-managed read tools into DSH MCP", async () => {
    const workspace = tempRoot();
    mkdirSync(join(workspace, "repository"));
    writeFileSync(join(workspace, "repository", "README.md"), "fixture\n");
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const events = await collect(adapter, context({
      workspace,
      allowedBuiltinTools: ["Read", "Grep", "Glob", "LS"],
      workspaceAccess: { writable_paths: [], readonly_paths: ["repository"] },
      maxBuiltinToolCalls: 12,
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "debug",
      source: "deepseek-harness",
      message: "runtime_prepared",
      data: expect.objectContaining({
        tool_count: 4,
        builtin_tools: ["Read", "Grep", "Glob", "LS"],
      }),
    }));
  });

  it("uses cooperative session cancellation for an active DSH turn", async () => {
    const root = tempRoot();
    const readyFile = join(root, "ready");
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const eventsPromise = collect(adapter, context({
      turnController: controller,
      environmentVariables: {
        DSH_FAKE_WAIT_FOR: "cancel",
        DSH_FAKE_READY_FILE: readyFile,
      },
    }));
    await vi.waitFor(() => expect(existsSync(readyFile)).toBe(true));

    await expect(controller.interrupt("stop now")).resolves.toEqual({ status: "interrupted" });
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ type: "done", finish_reason: "cancelled" });
    await controller.close({ outcome: "failed", reason: "cancelled" });
  });
});
