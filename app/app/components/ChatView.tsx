"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage, PostIdea } from "@/lib/types";
import { INITIAL_CHAT, SUGGESTED_PROMPTS } from "@/lib/mock";
import { generate, type ClaudeModel } from "@/lib/llm";
import { IconSend, IconSparkle, IconCompose } from "./icons";

// Steers Claude toward the app's job. Kept short — the CLI has no separate
// system channel we rely on, so this is prepended to each message.
const SYSTEM = `You are the in-app content copilot for an Instagram publishing tool aimed at creators and small brands. Help the user plan posts, write captions (with a few tasteful hashtags and emoji where they fit), and think through posting cadence and engagement. Be concise and practical — no preamble. When you draft captions, offer a couple of distinct options.`;

export default function ChatView({
  provider,
  model,
  claudeConnected,
  onOpenSettings,
  onUseIdea,
}: {
  provider: string;
  model: ClaudeModel;
  // null while the connection is still being probed on boot.
  claudeConnected: boolean | null;
  onOpenSettings: () => void;
  onUseIdea: (idea: PostIdea) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_CHAT);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    setMessages((m) => [...m, { id: `u${Date.now()}`, role: "user", text: t }]);
    setInput("");
    setThinking(true);
    try {
      const reply = await generate(t, { system: SYSTEM, model });
      setMessages((m) => [...m, { id: `a${Date.now()}`, role: "ai", text: reply }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((m) => [
        ...m,
        {
          id: `a${Date.now()}`,
          role: "ai",
          text: `${msg}\n\nConnect Claude in Settings to start chatting.`,
        },
      ]);
    } finally {
      setThinking(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function autoGrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  return (
    <div className="chat">
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
            <button key={p} className="chip" onClick={() => send(p)}>
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
            value={input}
            placeholder={`Message ${provider}…`}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
          />
          <button
            className="send-btn"
            onClick={() => send(input)}
            disabled={!input.trim() || thinking}
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
