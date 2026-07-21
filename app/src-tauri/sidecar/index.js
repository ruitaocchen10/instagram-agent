import * as readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { assembleAgentInput, } from "./context.js";
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
async function runSession(request, state, retriedWithoutSession) {
    const inputPlan = assembleAgentInput({
        prompt: request.prompt,
        history: request.history,
        sessionId: request.sessionId,
        sessionState: state,
    });
    const input = new AsyncMessageQueue();
    const agentQuery = query({
        prompt: input,
        options: {
            cwd: request.workspacePath,
            model: request.model,
            includePartialMessages: true,
            permissionMode: "dontAsk",
            allowedTools: ["Read", "Glob", "Grep"],
            tools: ["Read", "Glob", "Grep"],
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
    const session = {
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
