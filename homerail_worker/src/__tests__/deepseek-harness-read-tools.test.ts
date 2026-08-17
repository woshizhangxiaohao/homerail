import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeepSeekHarnessReadTools } from "../agent/deepseek-harness-read-tools.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "homerail-dsh-read-tools-"));
  roots.push(workspace);
  mkdirSync(join(workspace, "repository", "src"), { recursive: true });
  mkdirSync(join(workspace, "outside"), { recursive: true });
  writeFileSync(join(workspace, "repository", "src", "alpha.ts"), "export const alpha = true;\nsecond line\n");
  writeFileSync(join(workspace, "repository", "README.md"), "alpha docs\n");
  writeFileSync(join(workspace, "outside", "secret.txt"), "do not read\n");
  return workspace;
}

function tools(workspace: string, maxCalls?: number) {
  return new Map(createDeepSeekHarnessReadTools({
    workspace,
    workspaceAccess: { writable_paths: [], readonly_paths: ["repository"] },
    allowedTools: ["Read", "Grep", "Glob", "LS"],
    maxCalls,
  }).map((tool) => [tool.name, tool]));
}

describe("DeepSeek Harness HomeRail-managed read tools", () => {
  it("reads, searches, globs, and lists only declared workspace roots", async () => {
    const workspace = fixture();
    const available = tools(workspace);

    await expect(available.get("Read")!.handler({
      file_path: "repository/src/alpha.ts",
      offset: 1,
      limit: 1,
    })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("1\texport const alpha = true;") }],
    });
    await expect(available.get("Grep")!.handler({
      pattern: "alpha",
      path: "repository",
      glob: "**/*.ts",
    })).resolves.toMatchObject({
      content: [{ text: "src/alpha.ts:1:export const alpha = true;" }],
    });
    await expect(available.get("Glob")!.handler({
      pattern: "**/*.ts",
      path: "repository",
    })).resolves.toMatchObject({ content: [{ text: "src/alpha.ts" }] });
    await expect(available.get("LS")!.handler({ path: "repository" }))
      .resolves.toMatchObject({ content: [{ text: "README.md\nsrc/" }] });

    await expect(available.get("Read")!.handler({ file_path: "outside/secret.txt" }))
      .resolves.toMatchObject({ is_error: true, content: [{ text: expect.stringContaining("outside") }] });
    await expect(available.get("Read")!.handler({ file_path: "../etc/passwd" }))
      .resolves.toMatchObject({ is_error: true, content: [{ text: expect.stringContaining("traversal-free") }] });
  });

  it("rejects symlink escapes and enforces a shared built-in call budget", async () => {
    const workspace = fixture();
    symlinkSync(join(workspace, "outside", "secret.txt"), join(workspace, "repository", "escape"));
    const available = tools(workspace, 1);

    await expect(available.get("Read")!.handler({ file_path: "repository/escape" }))
      .resolves.toMatchObject({ is_error: true, content: [{ text: expect.stringContaining("outside") }] });
    await expect(available.get("LS")!.handler({ path: "repository" }))
      .resolves.toMatchObject({
        is_error: true,
        content: [{ text: expect.stringContaining("Built-in tool budget exhausted (1/1)") }],
      });
  });

  it("refuses mutating or shell built-ins", () => {
    const workspace = fixture();
    expect(() => createDeepSeekHarnessReadTools({
      workspace,
      workspaceAccess: { writable_paths: [], readonly_paths: ["repository"] },
      allowedTools: ["Read", "Write"],
    })).toThrow(/only supports HomeRail-managed read tools/);
  });
});
