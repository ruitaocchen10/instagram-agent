import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { query, } from "@anthropic-ai/claude-agent-sdk";
import { assembleAgentInput, } from "./context.js";
import { decideToolPermission, permissionGrantKey, } from "./permission-policy.js";
class AsyncMessageQueue {
    constructor() {
        this.messages = [];
        this.waiters = [];
        this.closed = false;
    }
    push(message) {
        if (this.closed)
            throw new Error("The Agent SDK session is closed.");
        const waiter = this.waiters.shift();
        if (waiter)
            waiter({ value: message, done: false });
        else
            this.messages.push(message);
    }
    close() {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) {
            waiter({ value: undefined, done: true });
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                const message = this.messages.shift();
                if (message)
                    return Promise.resolve({ value: message, done: false });
                if (this.closed)
                    return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => this.waiters.push(resolve));
            },
        };
    }
}
const sessions = new Map();
const pendingApprovals = new Map();
const standingGrants = new Map();
function emit(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function textDelta(message) {
    if (message.type !== "stream_event")
        return null;
    const event = message.event;
    if (event.type !== "content_block_delta" || event.delta.type !== "text_delta")
        return null;
    return event.delta.text;
}
function userMessage(prompt) {
    return {
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
    };
}
function workspaceGrants(workspacePath) {
    let grants = standingGrants.get(workspacePath);
    if (!grants) {
        grants = new Set();
        standingGrants.set(workspacePath, grants);
    }
    return grants;
}
function permissionHandler(session) {
    return async (toolName, input, options) => {
        const turn = session.pending;
        if (!turn) {
            return { behavior: "deny", message: "No active copilot request owns this tool call." };
        }
        const call = {
            toolName,
            input,
            ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
        };
        const workspacePath = turn.request.workspacePath;
        const policy = decideToolPermission(call, workspacePath, workspaceGrants(workspacePath));
        if (policy.decision === "allow") {
            return { behavior: "allow", updatedInput: input };
        }
        if (policy.decision === "deny") {
            return { behavior: "deny", message: policy.reason };
        }
        const approvalId = randomUUID();
        return new Promise((resolve) => {
            const abort = () => {
                pendingApprovals.delete(approvalId);
                emit({
                    type: "approval_cancelled",
                    requestId: turn.request.requestId,
                    approvalId,
                });
                resolve({ behavior: "deny", message: "Tool approval was cancelled." });
            };
            options.signal.addEventListener("abort", abort, { once: true });
            pendingApprovals.set(approvalId, {
                call,
                workspacePath,
                grantable: policy.grantable,
                resolve,
                cancel: () => options.signal.removeEventListener("abort", abort),
            });
            emit({
                type: "approval",
                requestId: turn.request.requestId,
                approvalId,
                toolName,
                input,
                grantable: policy.grantable,
                reason: policy.reason,
            });
        });
    };
}
function permissionHook(session) {
    return async (input) => {
        if (input.hook_event_name !== "PreToolUse")
            return {};
        const turn = session.pending;
        const toolInput = input.tool_input;
        if (!turn || !toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
            return {
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: "The tool request is not attached to an active copilot turn.",
                },
            };
        }
        const policy = decideToolPermission({ toolName: input.tool_name, input: toolInput }, turn.request.workspacePath, workspaceGrants(turn.request.workspacePath));
        return {
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: policy.decision === "prompt"
                    ? "ask"
                    : policy.decision === "allow"
                        ? "defer"
                        : "deny",
                permissionDecisionReason: policy.reason,
            },
        };
    };
}
function handlePermissionResponse(request) {
    const pending = pendingApprovals.get(request.approvalId);
    if (!pending)
        return;
    pendingApprovals.delete(request.approvalId);
    pending.cancel();
    if (request.decision === "deny") {
        pending.resolve({ behavior: "deny", message: "The user denied this tool request." });
        return;
    }
    if (request.decision === "always" && !pending.grantable) {
        pending.resolve({
            behavior: "deny",
            message: "This action must be approved individually and cannot receive a standing grant.",
        });
        return;
    }
    if (request.decision === "always") {
        workspaceGrants(pending.workspacePath).add(permissionGrantKey(pending.call));
    }
    pending.resolve({ behavior: "allow", updatedInput: pending.call.input });
}
async function runSession(request, state, retriedWithoutSession) {
    const inputPlan = assembleAgentInput({
        prompt: request.prompt,
        history: request.history,
        sessionId: request.sessionId,
        sessionState: state,
    });
    const input = new AsyncMessageQueue();
    let session;
    const agentQuery = query({
        prompt: input,
        options: {
            cwd: request.workspacePath,
            model: request.model,
            includePartialMessages: true,
            permissionMode: "default",
            canUseTool: (...args) => permissionHandler(session)(...args),
            hooks: {
                PreToolUse: [{ hooks: [(...args) => permissionHook(session)(...args)] }],
            },
            tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            settingSources: ["project"],
            systemPrompt: {
                type: "preset",
                preset: "claude_code",
                ...(request.system ? { append: request.system } : {}),
            },
            ...(inputPlan.resumeSessionId ? { resume: inputPlan.resumeSessionId } : {}),
            env: {
                ...process.env,
                CLAUDE_AGENT_SDK_CLIENT_APP: "socialite-desktop",
            },
        },
    });
    session = {
        input,
        query: agentQuery,
        pending: {
            request,
            text: "",
            retriedWithoutSession,
        },
        sessionId: inputPlan.resumeSessionId,
        expectedResumeSessionId: inputPlan.resumeSessionId,
        model: request.model,
    };
    sessions.set(request.conversationId, session);
    input.push(userMessage(inputPlan.prompt));
    void pumpSession(request.conversationId, session);
    return session;
}
async function pumpSession(conversationId, session) {
    try {
        for await (const message of session.query) {
            if (message.type === "system" && message.subtype === "init") {
                if (session.expectedResumeSessionId &&
                    message.session_id !== session.expectedResumeSessionId) {
                    throw new Error("The saved Agent SDK session is no longer available.");
                }
                session.expectedResumeSessionId = null;
                session.sessionId = message.session_id;
                if (session.pending) {
                    emit({
                        type: "session",
                        requestId: session.pending.request.requestId,
                        sessionId: message.session_id,
                    });
                }
                continue;
            }
            const delta = textDelta(message);
            if (delta && session.pending) {
                session.pending.text += delta;
                emit({
                    type: "delta",
                    requestId: session.pending.request.requestId,
                    text: delta,
                });
                continue;
            }
            if (message.type === "result" && session.pending) {
                const pending = session.pending;
                session.sessionId = message.session_id;
                if (message.subtype !== "success" || message.is_error) {
                    throw new Error(message.subtype === "success"
                        ? message.result || "Claude returned an error."
                        : message.errors.join("; ") || "Claude couldn't finish the request.");
                }
                emit({
                    type: "complete",
                    requestId: pending.request.requestId,
                    sessionId: message.session_id,
                    text: message.result || pending.text,
                });
                session.pending = null;
            }
        }
        throw new Error("The Agent SDK session ended unexpectedly.");
    }
    catch (error) {
        const pending = session.pending;
        sessions.delete(conversationId);
        session.input.close();
        try {
            session.query.close();
        }
        catch {
            // The failing query may already have closed its transport.
        }
        if (pending && !pending.retriedWithoutSession) {
            try {
                if (pending.text) {
                    emit({ type: "reset", requestId: pending.request.requestId });
                }
                await runSession(pending.request, "expired", true);
                return;
            }
            catch (retryError) {
                emit({
                    type: "error",
                    requestId: pending.request.requestId,
                    message: `Claude session recovery failed: ${errorText(retryError)}`,
                    recoverable: true,
                });
                return;
            }
        }
        if (pending) {
            emit({
                type: "error",
                requestId: pending.request.requestId,
                message: errorText(error),
                recoverable: true,
            });
        }
    }
}
async function handleGenerate(request) {
    const warm = sessions.get(request.conversationId);
    if (warm) {
        if (warm.pending) {
            emit({
                type: "error",
                requestId: request.requestId,
                message: "This conversation is already generating a reply.",
                recoverable: true,
            });
            return;
        }
        try {
            if (warm.model !== request.model) {
                await warm.query.setModel(request.model);
                warm.model = request.model;
            }
            const inputPlan = assembleAgentInput({
                prompt: request.prompt,
                history: request.history,
                sessionId: warm.sessionId,
                sessionState: "warm",
            });
            warm.pending = { request, text: "", retriedWithoutSession: false };
            warm.input.push(userMessage(inputPlan.prompt));
            return;
        }
        catch {
            sessions.delete(request.conversationId);
            warm.input.close();
        }
    }
    try {
        await runSession(request, request.sessionId ? "cold" : "expired", !request.sessionId);
    }
    catch (error) {
        if (!request.sessionId)
            throw error;
        await runSession(request, "expired", true);
    }
}
async function main() {
    emit({ type: "ready", protocolVersion: 1 });
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line.trim())
            continue;
        let request;
        try {
            request = JSON.parse(line);
            if (request.type === "permission_response") {
                if (!request.approvalId ||
                    !["once", "always", "deny"].includes(request.decision)) {
                    throw new Error("Malformed permission response.");
                }
                handlePermissionResponse(request);
                continue;
            }
            if (request.type !== "generate" ||
                !request.requestId ||
                !request.conversationId ||
                !request.prompt ||
                !request.workspacePath) {
                throw new Error("Malformed generate request.");
            }
        }
        catch (error) {
            emit({ type: "protocol_error", message: `Malformed IPC request: ${errorText(error)}` });
            continue;
        }
        try {
            await handleGenerate(request);
        }
        catch (error) {
            emit({
                type: "error",
                requestId: request.requestId,
                message: errorText(error),
                recoverable: true,
            });
        }
    }
    for (const session of sessions.values()) {
        session.input.close();
        session.query.close();
    }
    for (const approval of pendingApprovals.values()) {
        approval.cancel();
        approval.resolve({ behavior: "deny", message: "The Agent sidecar stopped." });
    }
    pendingApprovals.clear();
    sessions.clear();
}
process.on("uncaughtException", (error) => {
    emit({ type: "fatal", message: `Agent sidecar crashed: ${errorText(error)}` });
    process.exitCode = 1;
});
process.on("unhandledRejection", (error) => {
    emit({ type: "fatal", message: `Agent sidecar crashed: ${errorText(error)}` });
    process.exitCode = 1;
});
void main().catch((error) => {
    emit({ type: "fatal", message: `Agent sidecar couldn't start: ${errorText(error)}` });
    process.exitCode = 1;
});
