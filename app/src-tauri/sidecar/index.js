import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { createSdkMcpServer, query, tool, } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CAPTION_MAX, CREATE_DRAFT_SDK_TOOL, CREATE_DRAFT_TOOL, GET_ANALYTICS_SDK_TOOL, GET_ANALYTICS_TOOL, LIST_POSTS_SDK_TOOL, LIST_POSTS_TOOL, PUBLISH_NOW_SDK_TOOL, PUBLISH_NOW_TOOL, SCHEDULE_POST_SDK_TOOL, SCHEDULE_POST_TOOL, } from "./app-tool-contract.js";
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
const pendingAppToolCalls = new Map();
const standingGrants = new Map();
const MUTATING_APP_TOOLS = new Set([
    CREATE_DRAFT_TOOL,
    SCHEDULE_POST_TOOL,
    PUBLISH_NOW_TOOL,
]);
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
function appToolFailure(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}
function requestAppTool(session, toolName, input) {
    const turn = session.pending;
    if (!turn)
        return Promise.resolve(appToolFailure("No active copilot turn owns this action."));
    const toolCallId = randomUUID();
    return new Promise((resolve) => {
        pendingAppToolCalls.set(toolCallId, {
            turn,
            mutatesApplication: MUTATING_APP_TOOLS.has(toolName),
            resolve,
        });
        emit({
            type: "app_tool_request",
            requestId: turn.request.requestId,
            toolCallId,
            toolName,
            input,
        });
    });
}
function appToolServer(session) {
    return createSdkMcpServer({
        name: "socialite",
        version: "1.0.0",
        alwaysLoad: true,
        tools: [
            tool(CREATE_DRAFT_TOOL, "Create and durably save one local Instagram draft in Socialite.", {
                caption: z
                    .string()
                    .max(CAPTION_MAX)
                    .describe(`Instagram caption, up to ${CAPTION_MAX.toLocaleString()} characters.`),
                image_url: z
                    .string()
                    .url()
                    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
                    message: "Image URL must use http or https.",
                })
                    .describe("Public http(s) URL for the draft's single image."),
            }, async (input) => requestAppTool(session(), CREATE_DRAFT_TOOL, input)),
            tool(LIST_POSTS_TOOL, "List the creator's current Socialite drafts, scheduled posts, and published posts without changing them.", {}, async (input) => requestAppTool(session(), LIST_POSTS_TOOL, input)),
            tool(GET_ANALYTICS_TOOL, "Get available likes and comments for the creator's published Instagram posts. Missing metrics are explicitly marked unavailable.", {}, async (input) => requestAppTool(session(), GET_ANALYTICS_TOOL, input)),
            tool(SCHEDULE_POST_TOOL, "Schedule an existing local draft or reschedule a scheduled post in Socialite. Use list_posts first to get the post ID.", {
                post_id: z.string().min(1).describe("ID of an existing draft or scheduled post."),
                scheduled_at: z
                    .string()
                    .datetime({ offset: true })
                    .describe("Future ISO 8601 date and time including a UTC offset."),
            }, async (input) => requestAppTool(session(), SCHEDULE_POST_TOOL, input)),
            tool(PUBLISH_NOW_TOOL, "Publish an existing eligible Socialite draft or scheduled post to Instagram now. Use list_posts first and pass the listed caption and image URL unchanged; the user must approve every publish.", {
                post_id: z.string().min(1).describe("ID of the draft or scheduled post to publish."),
                caption: z
                    .string()
                    .max(CAPTION_MAX)
                    .describe("Exact caption currently shown for the target post."),
                image_url: z
                    .string()
                    .url()
                    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
                    message: "Image URL must use http or https.",
                })
                    .describe("Exact public image URL currently shown for the target post."),
            }, async (input) => requestAppTool(session(), PUBLISH_NOW_TOOL, input)),
        ],
    });
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
                detachAbortListener: () => options.signal.removeEventListener("abort", abort),
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
    pending.detachAbortListener();
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
function handleAppToolResponse(request) {
    const pending = pendingAppToolCalls.get(request.toolCallId);
    if (!pending)
        return;
    pendingAppToolCalls.delete(request.toolCallId);
    if (request.error) {
        pending.resolve(appToolFailure(request.error));
        return;
    }
    if (pending.mutatesApplication)
        pending.turn.applicationMutationCompleted = true;
    pending.resolve({
        content: [
            {
                type: "text",
                text: JSON.stringify(request.result ?? { ok: true }),
            },
        ],
    });
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
    const socialiteTools = appToolServer(() => session);
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
            tools: [
                "Read",
                "Write",
                "Edit",
                "Glob",
                "Grep",
                "Bash",
                CREATE_DRAFT_SDK_TOOL,
                LIST_POSTS_SDK_TOOL,
                GET_ANALYTICS_SDK_TOOL,
                SCHEDULE_POST_SDK_TOOL,
                PUBLISH_NOW_SDK_TOOL,
            ],
            mcpServers: { socialite: socialiteTools },
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
            applicationMutationCompleted: false,
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
        if (pending &&
            !pending.retriedWithoutSession &&
            !pending.applicationMutationCompleted) {
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
            warm.pending = {
                request,
                text: "",
                retriedWithoutSession: false,
                applicationMutationCompleted: false,
            };
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
            if (request.type === "app_tool_response") {
                if (!request.toolCallId ||
                    (typeof request.error !== "string" &&
                        (!request.result ||
                            typeof request.result !== "object" ||
                            Array.isArray(request.result)))) {
                    throw new Error("Malformed application tool response.");
                }
                handleAppToolResponse(request);
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
        approval.detachAbortListener();
        approval.resolve({ behavior: "deny", message: "The Agent sidecar stopped." });
    }
    pendingApprovals.clear();
    for (const pending of pendingAppToolCalls.values()) {
        pending.resolve(appToolFailure("The Agent sidecar stopped before the action completed."));
    }
    pendingAppToolCalls.clear();
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
