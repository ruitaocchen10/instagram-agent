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
import { deriveChatTitle } from "@/lib/chat-title";
import { SUGGESTED_PROMPTS } from "@/lib/mock";
import {
  respondToToolApproval,
  subscribeToolApprovals,
  type AppToolCall,
  type AppToolResult,
  type ClaudeModel,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "@/lib/llm";
import { continueConversation } from "@/lib/chat";
import {
  CREATE_DRAFT_TOOL,
  PUBLISH_NOW_SDK_TOOL,
  PUBLISH_NOW_TOOL,
} from "@/sidecar/app-tool-contract";
import {
  IconSend,
  IconSparkle,
  IconCompose,
  IconPlus,
  IconTrash,
  IconFolder,
  IconChat,
  IconPen,
  IconSearch,
  IconMoreVertical,
} from "./icons";

// Steers Claude toward the app's job. The Agent SDK appends this to its Claude
// Code system prompt while project-specific CLAUDE.md instructions load from disk.
const SYSTEM = `You are the in-app content copilot for an Instagram publishing tool aimed at creators and small brands. Help the user plan posts, write captions (with a few tasteful hashtags and emoji where they fit), and think through posting cadence and engagement. Be concise and practical — no preamble. When you draft captions, offer a couple of distinct options.

Project reference material, when present, is stored in the references/ directory of your working directory. Before answering a question that could be grounded in those materials, inspect the relevant reference files and base your answer on them.

Use ${CREATE_DRAFT_TOOL} when the user asks you to save a caption and image as a draft in the app. A draft exists only when the tool returns success. If the tool fails, clearly report the failure and never claim that the draft was created. Before publishing, use list_posts to select an eligible draft or scheduled post, then call ${PUBLISH_NOW_TOOL} with that post's exact ID, caption, and image URL. Publishing only succeeds after an explicit one-time approval. Report a denial or failure plainly, and report the returned Instagram media ID on success.`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// "3m ago" / "5h ago" / "2d ago" for recent activity, then a plain date.
function formatRelative(timestamp: number): string {
  if (!timestamp) return "just now";
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isPublishApproval(approval: ToolApprovalRequest): boolean {
  return approval.toolName === PUBLISH_NOW_TOOL || approval.toolName === PUBLISH_NOW_SDK_TOOL;
}

interface ConversationController {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
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
  onCreateConversation: (title: string) => Promise<string | null>;
  onRenameConversation: (title: string) => Promise<void>;
  onDeleteConversation: () => Promise<void>;
}

interface ProjectController {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  activeProject: ProjectSummary | null;
  onSelectProject: (projectId: string) => Promise<void>;
  onCreateProject: (name: string) => Promise<string | null>;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onSaveInstructions: (instructions: string) => Promise<void>;
}

// Which of the three levels the center column is showing.
type Level = "grid" | "project" | "chat";

type ModalState =
  | { kind: "create-project" }
  | { kind: "rename-project"; project: ProjectSummary }
  | { kind: "delete-project"; project: ProjectSummary }
  | { kind: "rename-chat"; conversation: ConversationSummary }
  | { kind: "delete-chat"; conversation: ConversationSummary }
  | null;

export default function ProjectsView({
  provider,
  model,
  claudeConnected,
  project,
  conversation,
  onOpenSettings,
  onUseIdea,
  onToolCall,
}: {
  provider: string;
  model: ClaudeModel;
  // null while the connection is still being probed on boot.
  claudeConnected: boolean | null;
  project: ProjectController;
  conversation: ConversationController;
  onOpenSettings: () => void;
  onUseIdea: (idea: PostIdea) => void;
  onToolCall: (call: AppToolCall) => Promise<AppToolResult>;
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
  const referenceInputRef = useRef<HTMLInputElement>(null);
  // Clicking "Projects" always lands on the grid (the app's homeplace).
  const [level, setLevel] = useState<Level>("grid");
  const [projectSearch, setProjectSearch] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [instructionsDraft, setInstructionsDraft] = useState(activeProject?.instructions ?? "");
  const [references, setReferences] = useState<ProjectReference[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(true);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [toolApprovals, setToolApprovals] = useState<readonly ToolApprovalRequest[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  // First message typed on the project page: send it once its new chat is the
  // active conversation. State (not a ref) so setting it re-runs the effect.
  const [pendingSend, setPendingSend] = useState<{ conversationId: string; text: string } | null>(
    null,
  );

  useEffect(() => subscribeToolApprovals(setToolApprovals), []);

  useEffect(() => {
    setInstructionsDraft(activeProject?.instructions ?? "");
  }, [activeProject?.id, activeProject?.instructions]);

  useEffect(() => {
    if (!activeProject) return;
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
        }
      })
      .finally(() => {
        if (!cancelled) setReferencesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  // Dismiss an open card menu on any click outside it.
  useEffect(() => {
    if (!menuProjectId) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".project-card-menu")) setMenuProjectId(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuProjectId]);

  const managementDisabled = thinking || managing || referenceBusy;

  async function send(text: string) {
    const t = text.trim();
    if (!t || thinking || managing || referenceBusy || !activeProject) return;
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
        conversationId: activeConversationId ?? "",
        sessionId: conversations.find((item) => item.id === activeConversationId)?.sessionId,
        publish: (message) => setMessages((current) => [...current, message]),
        update: (message) =>
          setMessages((current) =>
            current.map((item) => (item.id === message.id ? message : item)),
          ),
        persist: persistMessage,
        rememberSessionId,
        onToolCall,
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

  // Once the composer-first chat becomes the active conversation, deliver its
  // first message. Runs after the create settles (managing false, id matches).
  useEffect(() => {
    if (!pendingSend || managing || thinking) return;
    if (pendingSend.conversationId !== activeConversationId) return;
    const { text } = pendingSend;
    setPendingSend(null);
    void send(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSend, activeConversationId, managing, thinking]);

  const activeConversation = conversations.find((item) => item.id === activeConversationId);

  // ── Navigation ────────────────────────────────────────────────────────────
  async function openProjectHome(projectId: string) {
    setLevel("project");
    if (projectId !== activeProjectId) await onSelectProject(projectId);
  }

  async function openConversation(conversationId: string) {
    setLevel("chat");
    if (conversationId !== activeConversationId) await onSelectConversation(conversationId);
  }

  // Type + send on the project page: create a chat titled from the message,
  // enter it, and send that first message once it becomes active.
  async function startChatFromComposer() {
    const text = projectDraft.trim();
    if (!text || managementDisabled) return;
    setProjectDraft("");
    const id = await onCreateConversation(deriveChatTitle(text));
    if (!id) {
      setProjectDraft(text);
      return;
    }
    setPendingSend({ conversationId: id, text });
    setLevel("chat");
  }

  async function createProject(name: string) {
    const id = await onCreateProject(name);
    if (id) setLevel("project");
  }

  async function importReference(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeProject) return;

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
    if (!activeProject) return;
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

  async function answerToolApproval(decision: ToolApprovalDecision) {
    const approval = toolApprovals[0];
    if (!approval || approvalBusy) return;
    setApprovalBusy(true);
    setApprovalError(null);
    try {
      await respondToToolApproval(approval.approvalId, decision);
      if (decision === "deny" && isPublishApproval(approval)) {
        const denial: ChatMessage = {
          id: crypto.randomUUID(),
          role: "ai",
          text: "Publishing was denied. Nothing was published to Instagram.",
        };
        setMessages((current) => [...current, denial]);
        try {
          await persistMessage(denial);
        } catch (error) {
          onPersistenceError(errorMessage(error));
        }
      }
    } catch (error) {
      setApprovalError(`Couldn't send your decision: ${errorMessage(error)}`);
    } finally {
      setApprovalBusy(false);
    }
  }

  // A project can vanish mid-view (deleted elsewhere); fall back to the grid
  // rather than rendering a project page with nothing behind it.
  const showLevel: Level = level !== "grid" && !activeProject ? "grid" : level;

  return (
    <div className="projects">
      {showLevel === "grid" && (
        <ProjectGrid
          projects={projects}
          search={projectSearch}
          onSearch={setProjectSearch}
          disabled={managementDisabled}
          menuProjectId={menuProjectId}
          onToggleMenu={(id) => setMenuProjectId((current) => (current === id ? null : id))}
          onOpen={(id) => void openProjectHome(id)}
          onNewProject={() => setModal({ kind: "create-project" })}
          onRename={(p) => {
            setMenuProjectId(null);
            setModal({ kind: "rename-project", project: p });
          }}
          onDelete={(p) => {
            setMenuProjectId(null);
            setModal({ kind: "delete-project", project: p });
          }}
        />
      )}

      {showLevel === "project" && activeProject && (
        <div className="home-scroll">
          <div className="project-page">
            <nav className="crumbs" aria-label="Breadcrumb">
              <button className="crumb-link" onClick={() => setLevel("grid")}>
                Projects
              </button>
              <span className="crumb-sep">/</span>
              <span className="crumb-current">{activeProject.name}</span>
            </nav>

            <div className="project-page-grid">
              <div className="project-main">
                <div className="project-title-row">
                  <h1>{activeProject.name}</h1>
                  <div className="project-title-actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setModal({ kind: "rename-project", project: activeProject })}
                      disabled={managementDisabled}
                    >
                      <IconPen size={15} />
                      Rename
                    </button>
                    <button
                      className="btn btn-ghost btn-sm danger"
                      onClick={() => setModal({ kind: "delete-project", project: activeProject })}
                      disabled={managementDisabled}
                    >
                      <IconTrash size={15} />
                      Delete
                    </button>
                  </div>
                </div>

                <ProjectComposer
                  provider={provider}
                  value={projectDraft}
                  onChange={setProjectDraft}
                  onSubmit={() => void startChatFromComposer()}
                  disabled={managementDisabled}
                />

                <section className="chats-block">
                  <div className="chats-head">
                    <h2>Chats{conversations.length ? ` · ${conversations.length}` : ""}</h2>
                  </div>
                  {conversations.length === 0 ? (
                    <div className="chats-empty">
                      No chats yet — start one with the message box above.
                    </div>
                  ) : (
                    <ul className="chat-cards">
                      {conversations.map((item) => (
                        <li key={item.id} className="chat-card">
                          <button
                            className="chat-card-open"
                            onClick={() => void openConversation(item.id)}
                            disabled={managementDisabled}
                          >
                            <IconChat size={16} />
                            <span className="chat-card-title">{item.title}</span>
                            <span className="chat-card-date">{formatRelative(item.updatedAt)}</span>
                          </button>
                          <button
                            className="btn btn-ghost btn-sm conversation-icon-btn"
                            onClick={() => setModal({ kind: "rename-chat", conversation: item })}
                            disabled={managementDisabled}
                            aria-label={`Rename ${item.title}`}
                            title="Rename chat"
                          >
                            <IconPen size={14} />
                          </button>
                          <button
                            className="btn btn-ghost btn-sm conversation-icon-btn danger"
                            onClick={() => setModal({ kind: "delete-chat", conversation: item })}
                            disabled={managementDisabled}
                            aria-label={`Delete ${item.title}`}
                            title="Delete chat"
                          >
                            <IconTrash size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              <aside className="project-rail">
                <section className="rail-card">
                  <div className="rail-card-head">
                    <h2>Instructions</h2>
                  </div>
                  <p className="rail-card-hint">
                    Saved to this project&apos;s CLAUDE.md and used in every chat.
                  </p>
                  <textarea
                    id="project-instructions"
                    className="textarea rail-instructions"
                    value={instructionsDraft}
                    disabled={managementDisabled}
                    placeholder="Describe your brand voice, audience, cadence, and campaign goals."
                    onChange={(event) => setInstructionsDraft(event.target.value)}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={
                      managementDisabled || instructionsDraft === activeProject.instructions
                    }
                    onClick={() => void onSaveInstructions(instructionsDraft)}
                  >
                    Save instructions
                  </button>
                </section>

                <section className="rail-card">
                  <div className="rail-card-head">
                    <h2>Knowledge{referencesLoading ? "" : ` · ${references.length}`}</h2>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={managementDisabled || referencesLoading}
                      onClick={() => referenceInputRef.current?.click()}
                    >
                      <IconPlus size={15} />
                      {referenceBusy ? "Working…" : "Add"}
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
                    <div className="reference-empty">Loading knowledge…</div>
                  ) : references.length === 0 ? (
                    <div className="reference-empty">No files added yet.</div>
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
                </section>
              </aside>
            </div>
          </div>
        </div>
      )}

      {showLevel === "chat" && activeProject && (
        <div className="chat-main">
          <header className="chat-head">
            <nav className="crumbs" aria-label="Breadcrumb">
              <button className="crumb-link" onClick={() => setLevel("grid")}>
                Projects
              </button>
              <span className="crumb-sep">/</span>
              <button
                className="crumb-link"
                onClick={() => setLevel("project")}
                disabled={managementDisabled}
              >
                {activeProject.name}
              </button>
              <span className="crumb-sep">/</span>
              <span className="crumb-current">{activeConversation?.title ?? "Chat"}</span>
            </nav>
            <div className="conversation-actions">
              <button
                className="btn btn-ghost btn-sm conversation-icon-btn"
                onClick={() =>
                  activeConversation &&
                  setModal({ kind: "rename-chat", conversation: activeConversation })
                }
                disabled={managementDisabled || !activeConversation}
                aria-label="Rename chat"
                title="Rename chat"
              >
                <IconCompose size={15} />
              </button>
              <button
                className="btn btn-ghost btn-sm conversation-icon-btn danger"
                onClick={() =>
                  activeConversation &&
                  setModal({ kind: "delete-chat", conversation: activeConversation })
                }
                disabled={managementDisabled || !activeConversation}
                aria-label="Delete chat"
                title="Delete chat"
              >
                <IconTrash size={15} />
              </button>
            </div>
          </header>
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
                This chat is still visible, but it couldn&apos;t be saved: {persistenceError}
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

          {messages.length === 0 && !thinking && (
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
            <Composer
              provider={provider}
              value={draft}
              onChange={(value) => setDraft(value)}
              onSubmit={() => send(draft)}
              disabled={managementDisabled}
              variant="chat"
            />
          </div>
        </div>
      )}

      {toolApprovals[0] && (
        <ToolApprovalDialog
          approval={toolApprovals[0]}
          queueLength={toolApprovals.length}
          busy={approvalBusy}
          error={approvalError}
          onAnswer={(decision) => void answerToolApproval(decision)}
        />
      )}

      {modal?.kind === "create-project" && (
        <PromptModal
          title="New project"
          label="Project name"
          placeholder="e.g. Summer Campaign"
          confirmLabel="Create project"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            setModal(null);
            await createProject(name);
          }}
        />
      )}
      {modal?.kind === "rename-project" && (
        <PromptModal
          title="Rename project"
          label="Project name"
          initialValue={modal.project.name}
          confirmLabel="Save"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            const target = modal.project;
            setModal(null);
            await onRenameProject(target.id, name);
          }}
        />
      )}
      {modal?.kind === "rename-chat" && (
        <PromptModal
          title="Rename chat"
          label="Chat name"
          initialValue={modal.conversation.title}
          confirmLabel="Save"
          onClose={() => setModal(null)}
          onSubmit={async (title) => {
            const target = modal.conversation;
            setModal(null);
            if (target.id !== activeConversationId) await onSelectConversation(target.id);
            await onRenameConversation(title);
          }}
        />
      )}
      {modal?.kind === "delete-project" && (
        <ConfirmModal
          title={`Delete “${modal.project.name}”?`}
          body="This deletes the project and all of its chats. This can't be undone."
          confirmLabel="Delete project"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            const target = modal.project;
            setModal(null);
            await onDeleteProject(target.id);
            setLevel("grid");
          }}
        />
      )}
      {modal?.kind === "delete-chat" && (
        <ConfirmModal
          title={`Delete “${modal.conversation.title}”?`}
          body="This permanently deletes the chat and its history."
          confirmLabel="Delete chat"
          onClose={() => setModal(null)}
          onConfirm={async () => {
            const target = modal.conversation;
            setModal(null);
            if (target.id !== activeConversationId) await onSelectConversation(target.id);
            await onDeleteConversation();
            setLevel("project");
          }}
        />
      )}
    </div>
  );
}

function ProjectGrid({
  projects,
  search,
  onSearch,
  disabled,
  menuProjectId,
  onToggleMenu,
  onOpen,
  onNewProject,
  onRename,
  onDelete,
}: {
  projects: ProjectSummary[];
  search: string;
  onSearch: (value: string) => void;
  disabled: boolean;
  menuProjectId: string | null;
  onToggleMenu: (id: string) => void;
  onOpen: (id: string) => void;
  onNewProject: () => void;
  onRename: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}) {
  const query = search.trim().toLowerCase();
  const filtered = query
    ? projects.filter((project) => project.name.toLowerCase().includes(query))
    : projects;

  return (
    <div className="home-scroll">
      <div className="grid-page">
        <header className="grid-head">
          <h1>Projects</h1>
          <button className="btn btn-primary" onClick={onNewProject} disabled={disabled}>
            <IconPlus size={16} />
            New project
          </button>
        </header>

        {projects.length > 0 && (
          <div className="grid-search">
            <IconSearch size={17} />
            <input
              type="search"
              value={search}
              placeholder="Search projects…"
              onChange={(event) => onSearch(event.target.value)}
              aria-label="Search projects"
            />
          </div>
        )}

        {projects.length === 0 ? (
          <div className="grid-empty">
            <div className="grid-empty-icon">
              <IconFolder size={28} />
            </div>
            <h2>Create your first project</h2>
            <p>
              Projects keep your chats, instructions, and knowledge together. Every chat lives in a
              project.
            </p>
            <button className="btn btn-primary" onClick={onNewProject} disabled={disabled}>
              <IconPlus size={16} />
              New project
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid-empty">
            <p>No projects match “{search.trim()}”.</p>
          </div>
        ) : (
          <div className="project-cards">
            {filtered.map((project) => (
              <div key={project.id} className="project-card">
                <button
                  className="project-card-open"
                  onClick={() => onOpen(project.id)}
                  disabled={disabled}
                >
                  <div className="project-card-name">{project.name}</div>
                  <div className="project-card-date">{formatRelative(project.lastActivityAt)}</div>
                  <div className="project-card-foot">
                    <span className="project-card-count">
                      {project.chatCount === 0
                        ? "No chats"
                        : `${project.chatCount} chat${project.chatCount === 1 ? "" : "s"}`}
                    </span>
                  </div>
                </button>
                <div className="project-card-menu">
                  <button
                    className="project-card-menu-btn"
                    aria-label={`Actions for ${project.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuProjectId === project.id}
                    onClick={() => onToggleMenu(project.id)}
                    disabled={disabled}
                  >
                    <IconMoreVertical size={16} />
                  </button>
                  {menuProjectId === project.id && (
                    <div className="card-menu" role="menu">
                      <button role="menuitem" onClick={() => onRename(project)}>
                        <IconPen size={14} />
                        Rename
                      </button>
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() => onDelete(project)}
                      >
                        <IconTrash size={14} />
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({
  provider,
  value,
  onChange,
  onSubmit,
  disabled,
  variant,
}: {
  provider: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  variant: "chat" | "project";
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  function autoGrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className={`composer-inner${variant === "project" ? " composer-project" : ""}`}>
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={
          variant === "project" ? "Start a new chat in this project…" : `Message ${provider}…`
        }
        onChange={(event) => {
          onChange(event.target.value);
          autoGrow();
        }}
        onKeyDown={onKeyDown}
      />
      <button
        className="send-btn"
        onClick={onSubmit}
        disabled={!value.trim() || disabled}
        aria-label="Send message"
      >
        <IconSend size={18} />
      </button>
    </div>
  );
}

function ProjectComposer({
  provider,
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  provider: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="project-composer">
      <Composer
        provider={provider}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        disabled={disabled}
        variant="project"
      />
    </div>
  );
}

function PromptModal({
  title,
  label,
  placeholder,
  initialValue = "",
  confirmLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel: string;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();

  return (
    <ModalShell onClose={onClose} labelledBy="prompt-modal-title">
      <h2 id="prompt-modal-title">{title}</h2>
      <label className="modal-field">
        <span>{label}</span>
        <input
          ref={inputRef}
          className="input"
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && trimmed) {
              event.preventDefault();
              void onSubmit(trimmed);
            }
          }}
        />
      </label>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!trimmed}
          onClick={() => void onSubmit(trimmed)}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose} labelledBy="confirm-modal-title">
      <h2 id="confirm-modal-title">{title}</h2>
      <p className="modal-body">{body}</p>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  children,
  onClose,
  labelledBy,
}: {
  children: React.ReactNode;
  onClose: () => void;
  labelledBy: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ToolApprovalDialog({
  approval,
  queueLength,
  busy,
  error,
  onAnswer,
}: {
  approval: ToolApprovalRequest;
  queueLength: number;
  busy: boolean;
  error: string | null;
  onAnswer: (decision: ToolApprovalDecision) => void;
}) {
  const publishing = isPublishApproval(approval);
  return (
    <div className="approval-backdrop">
      <section
        className="approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-approval-title"
        aria-describedby="tool-approval-reason"
      >
        <div className="approval-heading">
          <div>
            <span className="approval-eyebrow">Copilot action</span>
            <h2 id="tool-approval-title">Allow {approval.toolName}?</h2>
          </div>
          {queueLength > 1 && <span className="approval-count">1 of {queueLength}</span>}
        </div>
        <p id="tool-approval-reason" className="approval-reason">
          {approval.reason}
        </p>
        <div className="approval-arguments">
          <span>{publishing ? "Target post, caption, media URL, and arguments" : "Arguments"}</span>
          <pre>{JSON.stringify(approval.input, null, 2)}</pre>
        </div>
        {!approval.grantable && (
          <p className="approval-warning">This action must be approved every time.</p>
        )}
        {error && (
          <p className="approval-error" role="alert">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={() => onAnswer("deny")}>
            Deny
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy || !approval.grantable}
            title={approval.grantable ? undefined : "Standing grants are disabled for this action."}
            onClick={() => onAnswer("always")}
          >
            Always allow this action
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => onAnswer("once")}>
            {busy ? "Sending…" : "Allow once"}
          </button>
        </div>
      </section>
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
