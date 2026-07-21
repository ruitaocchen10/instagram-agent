"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage, PostIdea } from "@/lib/types";
import type { ConversationSummary } from "@/lib/conversation-storage";
import { SUGGESTED_PROMPTS } from "@/lib/mock";
import type { ClaudeModel } from "@/lib/llm";
import { continueConversation } from "@/lib/chat";
import { IconSend, IconSparkle, IconCompose, IconPlus, IconTrash } from "./icons";

// Steers Claude toward the app's job. Kept short — the CLI has no separate
// system channel we rely on, so this is prepended to each message.
const SYSTEM = `You are the in-app content copilot for an Instagram publishing tool aimed at creators and small brands. Help the user plan posts, write captions (with a few tasteful hashtags and emoji where they fit), and think through posting cadence and engagement. Be concise and practical — no preamble. When you draft captions, offer a couple of distinct options.`;

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
  hasPendingMessages: () => boolean;
  onSelectConversation: (conversationId: string) => Promise<void>;
  onCreateConversation: (title: string) => Promise<void>;
  onRenameConversation: (title: string) => Promise<void>;
  onDeleteConversation: () => Promise<void>;
}

export default function ChatView({
  provider,
  model,
  claudeConnected,
  conversation,
  onOpenSettings,
  onUseIdea,
}: {
  provider: string;
  model: ClaudeModel;
  // null while the connection is still being probed on boot.
  claudeConnected: boolean | null;
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
    hasPendingMessages,
    onSelectConversation,
    onCreateConversation,
    onRenameConversation,
    onDeleteConversation,
  } = conversation;
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || thinking || managing) return;
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
        publish: (message) => setMessages((current) => [...current, message]),
        persist: persistMessage,
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
  const managementDisabled = thinking || managing;

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

  return (
    <div className="chat">
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
            <button key={p} className="chip" onClick={() => send(p)} disabled={managing}>
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
            disabled={managing}
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
            disabled={!draft.trim() || thinking || managing}
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
