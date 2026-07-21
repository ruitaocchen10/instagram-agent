import path from "node:path";

export type PermissionDecision = "allow" | "prompt" | "deny";

export interface ToolPermissionCall {
  toolName: string;
  input: Record<string, unknown>;
  blockedPath?: string;
}

export interface ToolPermissionDecision {
  decision: PermissionDecision;
  grantable: boolean;
  reason: string;
}

const REQUIRED_PATH_FIELD = new Map([
  ["Read", "file_path"],
  ["Write", "file_path"],
  ["Edit", "file_path"],
]);
const OPTIONAL_PATH_TOOLS = new Set(["Glob", "Grep"]);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function permissionGrantKey({ toolName, input }: Pick<ToolPermissionCall, "toolName" | "input">): string {
  return `${toolName}\n${stableJson(input)}`;
}

function isInsideWorkspace(candidate: string, workspacePath: string): boolean {
  if (candidate.includes("\0") || workspacePath.includes("\0")) return false;
  const workspace = path.resolve(workspacePath);
  const resolved = path.resolve(workspace, candidate);
  const relative = path.relative(workspace, resolved);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function fileTarget(call: ToolPermissionCall, workspacePath: string): string | null {
  const requiredField = REQUIRED_PATH_FIELD.get(call.toolName);
  if (requiredField) {
    const target = call.input[requiredField];
    return typeof target === "string" && target.length > 0 ? target : null;
  }
  if (!OPTIONAL_PATH_TOOLS.has(call.toolName)) return null;

  const target = call.input.path;
  if (typeof target === "string" && target.length > 0) return target;
  if (call.toolName === "Glob") {
    const pattern = call.input.pattern;
    if (typeof pattern === "string" && path.isAbsolute(pattern)) return pattern;
  }
  return workspacePath;
}

function prompt(reason: string, grantable: boolean): ToolPermissionDecision {
  return { decision: "prompt", grantable, reason };
}

export function decideToolPermission(
  call: ToolPermissionCall,
  workspacePath: string,
  standingGrants: Iterable<string>,
): ToolPermissionDecision {
  if (call.toolName === "publish_now") {
    return prompt("Publishing is outward-facing and must be approved every time.", false);
  }

  if (call.blockedPath && !isInsideWorkspace(call.blockedPath, workspacePath)) {
    return prompt("This operation reaches outside the active project.", false);
  }

  if (REQUIRED_PATH_FIELD.has(call.toolName) || OPTIONAL_PATH_TOOLS.has(call.toolName)) {
    const target = fileTarget(call, workspacePath);
    if (!target) {
      return {
        decision: "deny",
        grantable: false,
        reason: `${call.toolName} did not provide a valid path.`,
      };
    }
    if (!isInsideWorkspace(target, workspacePath)) {
      return prompt("This file operation reaches outside the active project.", false);
    }
    return {
      decision: "allow",
      grantable: false,
      reason: "This reversible file operation stays inside the active project.",
    };
  }

  if (call.toolName === "Bash") {
    if (new Set(standingGrants).has(permissionGrantKey(call))) {
      return {
        decision: "allow",
        grantable: false,
        reason: "An exact standing grant covers this safe action.",
      };
    }
    return prompt("Shell commands require approval.", true);
  }

  return {
    decision: "deny",
    grantable: false,
    reason: `${call.toolName} is not available to this copilot.`,
  };
}
