import path from "node:path";
const REQUIRED_PATH_FIELD = new Map([
    ["Read", "file_path"],
    ["Write", "file_path"],
    ["Edit", "file_path"],
]);
const OPTIONAL_PATH_TOOLS = new Set(["Glob", "Grep"]);
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}
export function permissionGrantKey({ toolName, input }) {
    return `${toolName}\n${stableJson(input)}`;
}
function isInsideWorkspace(candidate, workspacePath) {
    if (candidate.includes("\0") || workspacePath.includes("\0"))
        return false;
    const workspace = path.resolve(workspacePath);
    const resolved = path.resolve(workspace, candidate);
    const relative = path.relative(workspace, resolved);
    return (relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
}
function fileTarget(call, workspacePath) {
    const requiredField = REQUIRED_PATH_FIELD.get(call.toolName);
    if (requiredField) {
        const target = call.input[requiredField];
        return typeof target === "string" && target.length > 0 ? target : null;
    }
    if (!OPTIONAL_PATH_TOOLS.has(call.toolName))
        return null;
    const target = call.input.path;
    if (typeof target === "string" && target.length > 0)
        return target;
    return workspacePath;
}
function isGrantableShellAction(input) {
    if (typeof input.command !== "string")
        return false;
    const tokens = input.command.trim().split(/\s+/);
    if (tokens[0] === "pwd" && tokens.length === 1)
        return true;
    if (tokens[0] !== "git" || tokens[1] !== "status")
        return false;
    const readOnlyFlags = new Set([
        "--branch",
        "--porcelain",
        "--porcelain=v1",
        "--short",
        "-b",
        "-s",
    ]);
    return tokens.slice(2).every((token) => readOnlyFlags.has(token));
}
function prompt(reason, grantable) {
    return { decision: "prompt", grantable, reason };
}
export function decideToolPermission(call, workspacePath, standingGrants) {
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
        const targets = [target];
        if (call.toolName === "Glob") {
            const pattern = call.input.pattern;
            if (typeof pattern !== "string" || pattern.length === 0) {
                return {
                    decision: "deny",
                    grantable: false,
                    reason: "Glob did not provide a valid pattern.",
                };
            }
            targets.push(path.resolve(workspacePath, target, pattern));
        }
        if (targets.some((candidate) => !isInsideWorkspace(candidate, workspacePath))) {
            return prompt("This file operation reaches outside the active project.", false);
        }
        return {
            decision: "allow",
            grantable: false,
            reason: "This reversible file operation stays inside the active project.",
        };
    }
    if (call.toolName === "Bash") {
        const grantable = isGrantableShellAction(call.input);
        if (grantable && new Set(standingGrants).has(permissionGrantKey(call))) {
            return {
                decision: "allow",
                grantable: false,
                reason: "An exact standing grant covers this safe action.",
            };
        }
        return prompt(grantable
            ? "This read-only shell action requires approval."
            : "This shell command must be approved every time.", grantable);
    }
    return {
        decision: "deny",
        grantable: false,
        reason: `${call.toolName} is not available to this copilot.`,
    };
}
