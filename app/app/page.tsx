"use client";

import { useEffect, useState } from "react";
import Sidebar, { type ViewId } from "./components/Sidebar";
import DashboardView from "./components/DashboardView";
import ChatView from "./components/ChatView";
import ComposeView from "./components/ComposeView";
import CalendarView from "./components/CalendarView";
import LibraryView from "./components/LibraryView";
import SettingsView from "./components/SettingsView";
import { MOCK_ACCOUNT, MOCK_POSTS, MOCK_PROVIDERS } from "@/lib/mock";
import type { AiProviderId, Post, PostIdea } from "@/lib/types";

export default function Home() {
  const [view, setView] = useState<ViewId>("dashboard");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [posts, setPosts] = useState<Post[]>(MOCK_POSTS);
  const [provider, setProvider] = useState<AiProviderId>("claude");

  // Shared composer draft so the chat's "Send to composer" can prefill it.
  const [imageUrl, setImageUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 3500);
    return () => clearTimeout(t);
  }, [banner]);

  const account = MOCK_ACCOUNT;
  const providers = MOCK_PROVIDERS.map((p) => ({ ...p, connected: p.id === provider }));
  const providerName = providers.find((p) => p.id === provider)?.name ?? "Claude";

  const counts = {
    scheduled: posts.filter((p) => p.status === "scheduled").length,
    drafts: posts.filter((p) => p.status === "draft").length,
  };

  function useIdea(idea: PostIdea) {
    setImageUrl(idea.imageUrl.replace("/300/300", "/600/600"));
    setCaption(idea.caption);
    setView("compose");
    setBanner("Idea sent to composer.");
  }

  function editPost(p: Post) {
    setImageUrl(p.imageUrl);
    setCaption(p.caption);
    setView("compose");
  }

  function newId() {
    return `p${Date.now()}`;
  }

  function publishNow() {
    setPosts((ps) => [
      { id: newId(), imageUrl, caption, status: "published", publishedAt: Date.now(), likes: 0, comments: 0 },
      ...ps,
    ]);
    setImageUrl("");
    setCaption("");
    setBanner("Published! (mock)");
    setView("library");
  }

  function schedulePost(when: number) {
    setPosts((ps) => [
      { id: newId(), imageUrl, caption, status: "scheduled", scheduledAt: when },
      ...ps,
    ]);
    setImageUrl("");
    setCaption("");
    setBanner("Post scheduled.");
    setView("calendar");
  }

  function saveDraft() {
    setPosts((ps) => [{ id: newId(), imageUrl, caption, status: "draft" }, ...ps]);
    setBanner("Draft saved.");
    setView("library");
  }

  return (
    <div className="app">
      <Sidebar
        view={view}
        onNavigate={setView}
        account={account}
        counts={counts}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
      />

      <main className="main">
        {view === "chat" ? (
          // Chat owns the full viewport height (own scroll + sticky composer).
          <ChatView provider={providerName} onUseIdea={useIdea} />
        ) : (
          <div className="main-inner">
            {banner && (
              <div className="banner banner-ok" style={{ marginBottom: "var(--s4)" }}>
                {banner}
              </div>
            )}

            {view === "dashboard" && (
              <DashboardView account={account} posts={posts} onNavigate={setView} />
            )}
            {view === "compose" && (
              <ComposeView
                username={account.username}
                imageUrl={imageUrl}
                caption={caption}
                setImageUrl={setImageUrl}
                setCaption={setCaption}
                onPublish={publishNow}
                onSchedule={schedulePost}
                onSaveDraft={saveDraft}
              />
            )}
            {view === "calendar" && (
              <CalendarView posts={posts} onCompose={() => setView("compose")} />
            )}
            {view === "library" && (
              <LibraryView posts={posts} onEdit={editPost} onCompose={() => setView("compose")} />
            )}
            {view === "settings" && (
              <SettingsView
                account={account}
                providers={providers}
                activeProvider={provider}
                onSelectProvider={setProvider}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
