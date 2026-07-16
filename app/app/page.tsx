"use client";

import { useEffect, useState } from "react";
import Sidebar, { type ViewId } from "./components/Sidebar";
import DashboardView from "./components/DashboardView";
import ChatView from "./components/ChatView";
import ComposeView from "./components/ComposeView";
import CalendarView from "./components/CalendarView";
import LibraryView from "./components/LibraryView";
import SettingsView from "./components/SettingsView";
import ConnectView from "./components/ConnectView";
import { MOCK_PROVIDERS } from "@/lib/mock";
import { DEFAULT_CONFIG, fetchMedia, publishImage, resolveAccount } from "@/lib/instagram";
import {
  clearAccount,
  clearToken,
  getToken,
  loadAccount,
  loadPosts,
  saveAccount,
  savePost,
  setToken as persistToken,
} from "@/lib/storage";
import type { Account, AiProviderId, Post, PostIdea } from "@/lib/types";

export default function Home() {
  const [view, setView] = useState<ViewId>("dashboard");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Connection state. account === null means "not connected" → gated onboarding.
  const [booting, setBooting] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Two data domains:
  //   - localPosts: app-owned drafts + scheduled, persisted in SQLite.
  //   - published:  Instagram-owned, fetched live from the Graph API.
  const [localPosts, setLocalPosts] = useState<Post[]>([]);
  const [published, setPublished] = useState<Post[]>([]);
  const [provider, setProvider] = useState<AiProviderId>("claude");

  const posts = [...localPosts, ...published];

  // Shared composer draft so the chat's "Send to composer" can prefill it.
  const [imageUrl, setImageUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [banner, setBanner] = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  function notify(text: string, kind: "ok" | "err" = "ok") {
    setBanner({ text, kind });
  }

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Boot: load stored token + account + local posts. If connected, refresh the
  // live account/media from Instagram in the background.
  useEffect(() => {
    (async () => {
      const [tok, acct, local] = await Promise.all([getToken(), loadAccount(), loadPosts()]);
      setLocalPosts(local);
      if (tok && acct) {
        setAccessToken(tok);
        setAccount(acct);
        void refresh(tok, acct.igUserId);
      }
      setBooting(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), banner.kind === "err" ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [banner]);

  const providers = MOCK_PROVIDERS.map((p) => ({ ...p, connected: p.id === provider }));
  const providerName = providers.find((p) => p.id === provider)?.name ?? "Claude";

  const counts = {
    scheduled: posts.filter((p) => p.status === "scheduled").length,
    drafts: posts.filter((p) => p.status === "draft").length,
  };

  // Pull the freshest account (followers) + published media from Instagram.
  async function refresh(tok: string, igUserId: string) {
    setFetchError(null);
    try {
      const [freshAcct, media] = await Promise.all([
        resolveAccount(tok, DEFAULT_CONFIG),
        fetchMedia(tok, igUserId, DEFAULT_CONFIG),
      ]);
      setAccount(freshAcct);
      await saveAccount(freshAcct);
      setPublished(media);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    }
  }

  async function connect(rawToken: string) {
    setConnecting(true);
    setConnectError(null);
    try {
      const acct = await resolveAccount(rawToken, DEFAULT_CONFIG);
      await persistToken(rawToken);
      await saveAccount(acct);
      setAccessToken(rawToken);
      setAccount(acct);
      try {
        setPublished(await fetchMedia(rawToken, acct.igUserId, DEFAULT_CONFIG));
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : String(e));
      }
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    await clearToken();
    await clearAccount();
    setAccessToken(null);
    setAccount(null);
    setPublished([]);
    setFetchError(null);
    setView("dashboard");
  }

  function useIdea(idea: PostIdea) {
    setImageUrl(idea.imageUrl.replace("/300/300", "/600/600"));
    setCaption(idea.caption);
    setView("compose");
    notify("Idea sent to composer.");
  }

  function editPost(p: Post) {
    setImageUrl(p.imageUrl);
    setCaption(p.caption);
    setView("compose");
  }

  function newId() {
    return `p${Date.now()}`;
  }

  // Persist a new local post to SQLite, then reflect it in state.
  async function addLocalPost(post: Post) {
    await savePost(post);
    setLocalPosts((ps) => [post, ...ps.filter((p) => p.id !== post.id)]);
  }

  // Real publish: create container → poll → publish, then refetch so the new
  // post shows up from Instagram (the source of truth for published posts).
  async function publishNow() {
    if (!accessToken || !account) return;
    notify("Publishing to Instagram…");
    try {
      await publishImage(accessToken, account.igUserId, imageUrl, caption, DEFAULT_CONFIG);
      setImageUrl("");
      setCaption("");
      notify("Published to Instagram!");
      setView("library");
      try {
        setPublished(await fetchMedia(accessToken, account.igUserId, DEFAULT_CONFIG));
      } catch {
        /* the post published; a stale list will self-heal on next refresh */
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "Publish failed.", "err");
    }
  }

  async function schedulePost(when: number) {
    await addLocalPost({
      id: newId(),
      imageUrl,
      caption,
      status: "scheduled",
      scheduledAt: when,
      updatedAt: Date.now(),
    });
    setImageUrl("");
    setCaption("");
    notify("Post scheduled.");
    setView("calendar");
  }

  async function saveDraft() {
    await addLocalPost({
      id: newId(),
      imageUrl,
      caption,
      status: "draft",
      updatedAt: Date.now(),
    });
    notify("Draft saved.");
    setView("library");
  }

  if (booting) {
    return (
      <div className="connect-screen">
        <div className="muted">Loading…</div>
      </div>
    );
  }

  if (!account) {
    return <ConnectView onConnect={connect} connecting={connecting} error={connectError} />;
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
              <div className={`banner banner-${banner.kind}`} style={{ marginBottom: "var(--s4)" }}>
                {banner.text}
              </div>
            )}

            {fetchError && (
              <div className="banner banner-err" style={{ marginBottom: "var(--s4)" }}>
                Couldn&apos;t load Instagram data: {fetchError}
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
                onDisconnect={disconnect}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
