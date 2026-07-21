"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage, PostIdea } from "@/lib/types";
import type { ConversationSummary } from "@/lib/conversation-storage";
import {
  importProjectReference,
  listProjectReferences,
  removeProjectReference,
  type ProjectReference,
  type ProjectSummary,
} from "@/lib/project-storage";
import { SUGGESTED_PROMPTS } from "@/lib/mock";
import type { ClaudeModel } from "@/lib/llm";
import { continueConversation } from "@/lib/chat";
import { IconSend, IconSparkle, IconCompose, IconPlus, IconTrash } from "./icons";

// Steers Claude toward the app's job. The Agent SDK appends this to its Claude
// Code system prompt while project-specific CLAUDE.md instructions load from disk.
const SYSTEM = `You are the in-app content copilot for an Instagram publishing tool aimed at creators and small brands. Help the user plan posts, write captions (with a few tasteful hashtags and emoji where they fit), and think through posting cadence and engagement. Be concise and practical — no preamble. When you draft captions, offer a couple of distinct options.

Project reference material, when present, is stored in the references/ directory of your working directory. Before answering a question that could be grounded in those materials, inspect the relevant reference files and base your answer on them.`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ConversationController {
  conversations: ConversationSummary[];
  activeConversationId: string;
  managing: boolean;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  thinking: boolean;
  setThinking: React.Dispatch<React.SetStateAction<boolean>>;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  persistenceError: string | null;
  onPersistenceError: (error: string | null) => void;
  prepareHistory: () => Promise<ChatMessage[] | null>;
  persistMessage: (message: ChatMessage) => Promise<void>;
  rememberSessionId: (sessionId: string) => Promise<void>;
  hasPendingMessages: () => boolean;
  onSelectConversation: (conversationId: string) => Promise<void>;
  onCreateConversation: (title: string) => Promise<void>;
  onRenameConversation: (title: string) => Promise<void>;
  onDeleteConversation: () => Promise<void>;
}

interface ProjectController {
  projects: ProjectSummary[];
  activeProjectId: string;
  activeProject: ProjectSummary;
  onSelectProject: (projectId: string) => Promise<void>;
  onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (name: string) => Promise<void>;
  onDeleteProject: () => Promise<void>;
  onSaveInstructions: (instructions: string) => Promise<void>;
}

export default function ChatView({
  provider,
  model,
  claudeConnected,
  project,
  conversation,
  onOpenSettings,
  onUseIdea,
}: {
  provider: string;
  model: ClaudeModel;
  // null while the connection is still being probed on boot.
  claudeConnected: boolean | null;
  project: ProjectController;
  conversation: ConversationController;
  onOpenSettings: () => void;
  onUseIdea: (idea: PostIdea) => void;
}) {
  const {
    conversations,
    activeConversationId,
    managing,
    messages,
    setMessages,
    thinking,
    setThinking,
    draft,
    setDraft,
    persistenceError,
    onPersistenceError,
    prepareHistory,
    persistMessage,
    rememberSessionId,
    hasPendingMessages,
    onSelectConversation,
    onCreateConversation,
    onRenameConversation,
    onDeleteConversation,
  } = conversation;
  const {
    projects,
    activeProjectId,
    activeProject,
    onSelectProject,
    onCreateProject,
    onRenameProject,
    onDeleteProject,
    onSaveInstructions,
  } = project;
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(activeProject.instructions);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [references, setReferences] = useState<ProjectReference[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(true);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  useEffect(() => {
    setInstructionsDraft(activeProject.instructions);
    setInstructionsOpen(false);
  }, [activeProject.id, activeProject.instructions]);

  useEffect(() => {
    let cancelled = false;
    setReferences([]);
    setReferencesLoading(true);
    setReferenceError(null);
    void listProjectReferences(activeProject.id)
      .then((files) => {
        if (!cancelled) setReferences(files);
      })
      .catch((error) => {
        if (!cancelled) {
          setReferenceError(`Couldn't load references: ${errorMessage(error)}`);
          setReferencesOpen(true);
        }
      })
      .finally(() => {
        if (!cancelled) setReferencesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || thinking || managing || referenceBusy) return;
    setThinking(true);
    try {
      // A boot-time restore can fail transiently. Retry it before generating so
      // a follow-up never answers without durable earlier context.
      const history = await prepareHistory();
      if (!history) {
        setDraft(t);
        return;
      }
      setDraft("");
      const result = await continueConversation({
        text: t,
        history,
        model,
        system: SYSTEM,
        workspacePath: activeProject.workspacePath,
        conversationId: activeConversationId,
        sessionId: conversations.find((item) => item.id === activeConversationId)?.sessionId,
        publish: (message) => setMessages((current) => [...current, message]),
        update: (message) =>
          setMessages((current) =>
            current.map((item) => (item.id === message.id ? message : item)),
          ),
        persist: persistMessage,
        rememberSessionId,
      });
      if (hasPendingMessages()) {
        onPersistenceError(result.persistenceErrors.join("; "));
      } else {
        onPersistenceError(null);
      }
    } finally {
      setThinking(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(draft);
    }
  }

  function autoGrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  const activeConversation = conversations.find(
    (item) => item.id === activeConversationId,
  );
  const managementDisabled = thinking || managing || referenceBusy;

  function createNamedConversation() {
    const title = window.prompt("Name this conversation:");
    if (title?.trim()) void onCreateConversation(title.trim());
  }

  function renameActiveConversation() {
    const title = window.prompt(
      "Rename this conversation:",
      activeConversation?.title ?? "",
    );
    if (title?.trim() && title.trim() !== activeConversation?.title) {
      void onRenameConversation(title.trim());
    }
  }

  function deleteActiveConversation() {
    const title = activeConversation?.title ?? "this conversation";
    if (window.confirm(`Delete “${title}”? This can't be undone.`)) {
      void onDeleteConversation();
    }
  }

  function createNamedProject() {
    const name = window.prompt("Name this project:");
    if (name?.trim()) void onCreateProject(name.trim());
  }

  function renameActiveProject() {
    const name = window.prompt("Rename this project:", activeProject.name);
    if (name?.trim() && name.trim() !== activeProject.name) {
      void onRenameProject(name.trim());
    }
  }

  function deleteActiveProject() {
    if (
      window.confirm(
        `Delete “${activeProject.name}” and all of its conversations? This can't be undone.`,
      )
    ) {
      void onDeleteProject();
    }
  }

  async function importReference(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setReferenceBusy(true);
    setReferenceError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const imported = await importProjectReference(activeProject.id, file.name, bytes);
      setReferences((current) =>
        [...current, imported].sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
        ),
      );
    } catch (error) {
      setReferenceError(`Couldn't import “${file.name}”: ${errorMessage(error)}`);
    } finally {
      setReferenceBusy(false);
    }
  }

  async function deleteReference(reference: ProjectReference) {
    if (
      !window.confirm(
        `Remove “${reference.name}” from “${activeProject.name}”? This can't be undone.`,
      )
    ) {
      return;
    }

    setReferenceBusy(true);
    setReferenceError(null);
    try {
      await removeProjectReference(activeProject.id, reference.name);
      setReferences((current) => current.filter((item) => item.name !== reference.name));
    } catch (error) {
      setReferenceError(`Couldn't remove “${reference.name}”: ${errorMessage(error)}`);
    } finally {
      setReferenceBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="project-bar">
        <label className="conversation-picker project-picker">
          <span>Project</span>
          <select
            value={activeProjectId}
            disabled={managementDisabled}
            onChange={(event) => void onSelectProject(event.target.value)}
            aria-label="Active project"
          >
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className="conversation-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setInstructionsOpen((open) => !open);
              setReferencesOpen(false);
            }}
            disabled={managementDisabled}
          >
            Instructions
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setReferencesOpen((open) => !open);
              setInstructionsOpen(false);
            }}
            disabled={managementDisabled}
          >
            References{referencesLoading ? "" : ` (${references.length})`}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={createNamedProject}
            disabled={managementDisabled}
          >
            <IconPlus size={15} />
            New project
          </button>
          <button
            className="btn btn-ghost btn-sm conversation-icon-btn"
            onClick={renameActiveProject}
            disabled={managementDisabled}
            aria-label="Rename project"
            title="Rename project"
          >
            <IconCompose size={15} />
          </button>
          <button
            className="btn btn-ghost btn-sm conversation-icon-btn danger"
            onClick={deleteActiveProject}
            disabled={managementDisabled}
            aria-label="Delete project"
            title="Delete project"
          >
            <IconTrash size={15} />
          </button>
        </div>
      </div>
      {instructionsOpen && (
        <div className="project-instructions">
          <label htmlFor="project-instructions">Standing instructions</label>
          <textarea
            id="project-instructions"
            className="textarea"
            value={instructionsDraft}
            disabled={managementDisabled}
            placeholder="Describe your brand voice, audience, cadence, and campaign goals."
            onChange={(event) => setInstructionsDraft(event.target.value)}
          />
          <div className="project-instructions-actions">
            <span>Saved to this project&apos;s CLAUDE.md and used in every conversation.</span>
            <button
              className="btn btn-primary btn-sm"
              disabled={
                managementDisabled || instructionsDraft === activeProject.instructions
              }
              onClick={() => void onSaveInstructions(instructionsDraft)}
            >
              Save instructions
            </button>
          </div>
        </div>
      )}
      {referencesOpen && (
        <div className="project-references">
          <div className="project-references-header">
            <div>
              <strong>Reference material</strong>
              <span>Files are copied into this project and available to its conversations.</span>
            </div>
            <button
              className="btn btn-primary btn-sm"
              disabled={managementDisabled || referencesLoading}
              onClick={() => referenceInputRef.current?.click()}
            >
              <IconPlus size={15} />
              {referenceBusy ? "Working…" : "Add file"}
            </button>
            <input
              ref={referenceInputRef}
              hidden
              type="file"
              aria-label="Choose a reference file"
              onChange={(event) => void importReference(event)}
            />
          </div>
          {referenceError && (
            <div className="reference-error" role="alert">
              {referenceError}
            </div>
          )}
          {referencesLoading ? (
            <div className="reference-empty">Loading references…</div>
          ) : references.length === 0 ? (
            <div className="reference-empty">No reference files imported yet.</div>
          ) : (
            <ul className="reference-list">
              {references.map((reference) => (
                <li key={reference.name}>
                  <div>
                    <span className="reference-name">{reference.name}</span>
                    <span className="reference-size">{formatFileSize(reference.size)}</span>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm conversation-icon-btn danger"
                    disabled={managementDisabled}
                    aria-label={`Remove ${reference.name}`}
                    title={`Remove ${reference.name}`}
                    onClick={() => void deleteReference(reference)}
                  >
                    <IconTrash size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="conversation-bar">
        <label className="conversation-picker">
          <span>Conversation</span>
          <select
            value={activeConversationId}
            disabled={managementDisabled}
            onChange={(event) => void onSelectConversation(event.target.value)}
            aria-label="Active conversation"
          >
            {conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <div className="conversation-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={createNamedConversation}
            disabled={managementDisabled}
          >
            <IconPlus size={15} />
            New
          </button>
          <button
            className="btn btn-ghost btn-sm conversation-icon-btn"
            onClick={renameActiveConversation}
            disabled={managementDisabled}
            aria-label="Rename conversation"
            title="Rename conversation"
          >
            <IconCompose size={15} />
          </button>
          <button
            className="btn btn-ghost btn-sm conversation-icon-btn danger"
            onClick={deleteActiveConversation}
            disabled={managementDisabled}
            aria-label="Delete conversation"
            title="Delete conversation"
          >
            <IconTrash size={15} />
          </button>
        </div>
      </div>
      {claudeConnected === false && (
        <div className="banner banner-err chat-connect-banner">
          <span>
            {provider} isn&apos;t connected, so replies won&apos;t generate. Set it up to start
            chatting.
          </span>
          <button className="btn btn-grad btn-sm" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      )}
      {persistenceError && (
        <div className="banner banner-err chat-connect-banner">
          <span>
            This conversation is still visible, but it couldn&apos;t be saved: {persistenceError}
          </span>
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-thread">
          {messages.map((m) => (
            <Message key={m.id} msg={m} onUseIdea={onUseIdea} />
          ))}
          {thinking && (
            <div className="msg ai">
              <div className="av">
                <IconSparkle size={16} />
              </div>
              <div className="bubble">
                <div className="typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {messages.length <= 1 && (
        <div className="suggests">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              className="chip"
              onClick={() => send(p)}
              disabled={managementDisabled}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="composer-bar">
        <div className="composer-inner">
          <textarea
            ref={taRef}
            rows={1}
            value={draft}
            disabled={managementDisabled}
            placeholder={`Message ${provider}…`}
            onChange={(e) => {
              setDraft(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
          />
          <button
            className="send-btn"
            onClick={() => send(draft)}
            disabled={!draft.trim() || managementDisabled}
            aria-label="Send message"
          >
            <IconSend size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function Message({ msg, onUseIdea }: { msg: ChatMessage; onUseIdea: (i: PostIdea) => void }) {
  return (
    <div className={`msg ${msg.role}`}>
      <div className="av">{msg.role === "ai" ? <IconSparkle size={16} /> : "You"}</div>
      <div>
        <div className="bubble">{msg.text}</div>
        {msg.ideas && (
          <div className="idea-cards">
            {msg.ideas.map((idea) => (
              <div key={idea.id} className="idea">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="swatch" src={idea.imageUrl} alt="" />
                <div className="i-body">
                  <div className="i-t">{idea.title}</div>
                  <div className="i-c">{idea.caption}</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => onUseIdea(idea)}>
                  <IconCompose size={15} />
                  Send to composer
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
