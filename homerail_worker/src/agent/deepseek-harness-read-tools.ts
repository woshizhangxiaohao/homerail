import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { AgentBuiltinToolName, DagWorkspaceAccess } from "homerail-protocol";
import type { DagToolDefinition } from "./types.js";

const SUPPORTED_READ_TOOLS = new Set<string>(["Read", "Grep", "Glob", "LS"]);
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_GLOB_RESULTS = 1_000;
const MAX_GREP_RESULTS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_RESULT_CHARS = 120_000;

interface ReadToolOptions {
  workspace: string;
  workspaceAccess: DagWorkspaceAccess;
  allowedTools: AgentBuiltinToolName[];
  maxCalls?: number;
}

interface PolicyRoots {
  workspace: string;
  roots: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return Boolean(normalized)
    && !path.posix.isAbsolute(normalized)
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..")
    && !normalized.includes("\0");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function policyRoots(options: ReadToolOptions): PolicyRoots {
  const workspace = realpathSync(path.resolve(options.workspace));
  const configured = [
    ...options.workspaceAccess.writable_paths,
    ...(options.workspaceAccess.readonly_paths ?? []),
  ];
  const roots = configured.map((entry) => {
    if (!safeRelativePath(entry)) {
      throw new Error(`DSH workspace read policy path must be relative and traversal-free: ${entry}`);
    }
    const lexical = path.resolve(workspace, entry);
    if (!isWithin(workspace, lexical)) {
      throw new Error(`DSH workspace read policy root escapes workspace: ${entry}`);
    }
    const resolved = realpathSync(lexical);
    if (!isWithin(workspace, resolved)) {
      throw new Error(`DSH workspace read policy root escapes workspace: ${entry}`);
    }
    return resolved;
  });
  return { workspace, roots: [...new Set(roots)] };
}

function stringArg(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key] ?? fallback;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${key} must be a non-empty path or pattern`);
  }
  return value.trim();
}

function positiveIntegerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${key} must be an integer from 1 through ${maximum}`);
  }
  return Number(value);
}

function resolveTarget(policy: PolicyRoots, requested: string): string {
  if (!safeRelativePath(requested)) {
    throw new Error(`path must be relative and traversal-free: ${requested}`);
  }
  const resolved = realpathSync(path.resolve(policy.workspace, requested));
  if (!isWithin(policy.workspace, resolved) || !policy.roots.some((root) => isWithin(root, resolved))) {
    throw new Error(`path is outside the declared workspace roots: ${requested}`);
  }
  return resolved;
}

function bounded(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[output truncated at ${MAX_RESULT_CHARS} characters]`;
}

function result(text: string, isError = false): Awaited<ReturnType<DagToolDefinition["handler"]>> {
  return {
    content: [{ type: "text", text: bounded(text) }],
    ...(isError ? { is_error: true } : {}),
  };
}

function globRegex(pattern: string): RegExp {
  if (!pattern.trim() || pattern.length > 2_000 || pattern.includes("\0") || path.isAbsolute(pattern)) {
    throw new Error("pattern must be a relative glob of at most 2000 characters");
  }
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) {
    throw new Error("pattern must not traverse outside the search path");
  }
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function enumerateFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_DIRECTORY_ENTRIES) {
        throw new Error(`workspace search exceeded ${MAX_DIRECTORY_ENTRIES} directory entries`);
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

function relativeToSearchRoot(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function readHandler(policy: PolicyRoots, args: Record<string, unknown>) {
  const requested = stringArg(args, "file_path");
  const target = resolveTarget(policy, requested);
  const stats = statSync(target);
  if (!stats.isFile()) throw new Error(`Read target is not a file: ${requested}`);
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error(`Read target exceeds ${MAX_FILE_BYTES} bytes: ${requested}`);
  }
  const offset = positiveIntegerArg(args, "offset", 1, 10_000_000);
  const limit = positiveIntegerArg(args, "limit", 400, MAX_READ_LINES);
  const lines = readFileSync(target, "utf8").split(/\r?\n/);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(Math.min(lines.length, offset + selected.length)).length;
  return selected.map((line, index) => `${String(offset + index).padStart(width)}\t${line}`).join("\n");
}

function lsHandler(policy: PolicyRoots, args: Record<string, unknown>) {
  const requested = stringArg(args, "path");
  const target = resolveTarget(policy, requested);
  const stats = statSync(target);
  if (!stats.isDirectory()) throw new Error(`LS target is not a directory: ${requested}`);
  const entries = readdirSync(target, { withFileTypes: true });
  if (entries.length > MAX_GLOB_RESULTS) {
    throw new Error(`LS target exceeds ${MAX_GLOB_RESULTS} entries: ${requested}`);
  }
  return entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : entry.isSymbolicLink() ? "@" : ""}`)
    .join("\n");
}

function globHandler(policy: PolicyRoots, args: Record<string, unknown>) {
  const requested = stringArg(args, "path");
  const root = resolveTarget(policy, requested);
  if (!statSync(root).isDirectory()) throw new Error(`Glob path is not a directory: ${requested}`);
  const matches = globRegex(stringArg(args, "pattern"));
  const paths = enumerateFiles(root)
    .map((candidate) => relativeToSearchRoot(root, candidate))
    .filter((candidate) => matches.test(candidate))
    .sort();
  if (paths.length > MAX_GLOB_RESULTS) {
    return `${paths.slice(0, MAX_GLOB_RESULTS).join("\n")}\n[${paths.length - MAX_GLOB_RESULTS} additional paths omitted]`;
  }
  return paths.join("\n");
}

function grepHandler(policy: PolicyRoots, args: Record<string, unknown>) {
  const requested = stringArg(args, "path");
  const target = resolveTarget(policy, requested);
  const pattern = stringArg(args, "pattern");
  if (pattern.length > 2_000) throw new Error("pattern must be at most 2000 characters");
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, args.case_insensitive === true ? "i" : "");
  } catch (error) {
    throw new Error(`invalid Grep regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const include = typeof args.glob === "string" && args.glob.trim()
    ? globRegex(args.glob.trim())
    : undefined;
  const files = statSync(target).isFile() ? [target] : enumerateFiles(target);
  const matches: string[] = [];
  for (const file of files) {
    const relative = statSync(target).isFile() ? path.basename(file) : relativeToSearchRoot(target, file);
    if (include && !include.test(relative)) continue;
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;
    const content = readFileSync(file);
    if (content.includes(0)) continue;
    const lines = content.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      expression.lastIndex = 0;
      if (!expression.test(lines[index])) continue;
      matches.push(`${relative}:${index + 1}:${lines[index]}`);
      if (matches.length >= MAX_GREP_RESULTS) {
        return `${matches.join("\n")}\n[results truncated at ${MAX_GREP_RESULTS} matches]`;
      }
    }
  }
  return matches.join("\n");
}

function schemaFor(name: AgentBuiltinToolName): Record<string, unknown> {
  const pathProperty = { type: "string", description: "Workspace-relative path inside a declared HomeRail root." };
  if (name === "Read") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: {
        file_path: pathProperty,
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES },
      },
    };
  }
  if (name === "Grep") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["pattern", "path"],
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: pathProperty,
        glob: { type: "string", description: "Optional relative glob limiting searched files." },
        case_insensitive: { type: "boolean" },
      },
    };
  }
  if (name === "Glob") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["pattern", "path"],
      properties: {
        pattern: { type: "string", description: "Relative glob such as **/*.ts." },
        path: pathProperty,
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: pathProperty },
  };
}

function descriptionFor(name: AgentBuiltinToolName): string {
  if (name === "Read") return "Read a bounded line range from one file inside the HomeRail-declared workspace roots.";
  if (name === "Grep") return "Search file contents inside the HomeRail-declared workspace roots with bounded results.";
  if (name === "Glob") return "Find files by relative glob inside one HomeRail-declared workspace root.";
  return "List one directory inside the HomeRail-declared workspace roots.";
}

export function supportsDeepSeekHarnessReadTools(tools: readonly string[]): boolean {
  return tools.every((tool) => SUPPORTED_READ_TOOLS.has(tool));
}

export function createDeepSeekHarnessReadTools(options: ReadToolOptions): DagToolDefinition[] {
  if (!supportsDeepSeekHarnessReadTools(options.allowedTools)) {
    const unsupported = options.allowedTools.filter((tool) => !SUPPORTED_READ_TOOLS.has(tool));
    throw new Error(`DeepSeek Harness only supports HomeRail-managed read tools; unsupported: ${unsupported.join(", ")}`);
  }
  if (options.maxCalls !== undefined && (!Number.isInteger(options.maxCalls) || options.maxCalls < 1)) {
    throw new Error("built-in tool budget must be a positive integer");
  }
  const policy = policyRoots(options);
  let calls = 0;
  return options.allowedTools.map((name) => ({
    name,
    description: descriptionFor(name),
    input_schema: schemaFor(name),
    handler: async (args) => {
      if (!isRecord(args)) return result(`${name} arguments must be an object`, true);
      if (options.maxCalls !== undefined && calls >= options.maxCalls) {
        return result(
          `Built-in tool budget exhausted (${options.maxCalls}/${options.maxCalls}). Stop inspecting and call an allowed HomeRail DAG handoff tool now.`,
          true,
        );
      }
      calls += 1;
      try {
        const text = name === "Read"
          ? readHandler(policy, args)
          : name === "Grep"
            ? grepHandler(policy, args)
            : name === "Glob"
              ? globHandler(policy, args)
              : lsHandler(policy, args);
        return result(text || "No results.");
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true);
      }
    },
  }));
}
