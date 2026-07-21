"use client";

import { useEffect, useRef, useState } from "react";
import Sidebar, { type ViewId } from "./components/Sidebar";
import DashboardView from "./components/DashboardView";
import ChatView from "./components/ChatView";
import ComposeView from "./components/ComposeView";
import CalendarView from "./components/CalendarView";
import LibraryView from "./components/LibraryView";
import SettingsView from "./components/SettingsView";
import ConnectView from "./components/ConnectView";
import UpgradeStep from "./components/UpgradeStep";
import ConnectClaudeStep from "./components/ConnectClaudeStep";
import { useClaudeStatus } from "@/lib/useClaudeStatus";
import type { ClaudeModel } from "@/lib/llm";
import { INITIAL_CHAT, MOCK_PROVIDERS } from "@/lib/mock";
import {
  loadDefaultConversation,
  saveConversationMessage,
} from "@/lib/conversation-storage";
import { createConversationOutbox } from "@/lib/chat";
import {
  AuthError,
  DEFAULT_CONFIG,
  fetchMedia,
  publishImage,
  refreshToken,
  resolveAccount,
} from "@/lib/instagram";
import { classifyToken } from "@/lib/token-state";
import {
  clearAccount,
  clearToken,
  clearTokenExpiry,
  getFollowerDelta,
  getToken,
  loadAccount,
  loadPosts,
  loadTokenExpiry,
  recordFollowerSnapshot,
  saveAccount,
  savePost,
  saveTokenExpiry,
  setToken as persistToken,
} from "@/lib/storage";
import type { Account, AiProviderId, ChatMessage, Post, PostIdea } from "@/lib/types";

// How often the app re-checks token health in the background and refreshes if
// the classifier says the token is eligible and approaching expiry.
const REFRESH_CHECK_MS = 15 * 60 * 1000;

// Connection-health tri-state: null = healthy; "expired" = lapsed, just
// reconnect; "revoked" = invalid (password change / de-auth), needs a new token.
type ExpiredKind = null | "expired" | "revoked";

export default function Home() {
  const [view, setView] = useState<ViewId>("dashboard");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  // Chat thread lives here, not in ChatView, so it persists across tab switches
  // (ChatView unmounts whenever another view is showing). SQLite restores it on
  // application boot.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(INITIAL_CHAT);
  const [chatPersistenceError, setChatPersistenceError] = useState<string | null>(null);
  const [chatNeedsRestore, setChatNeedsRestore] = useState(false);
  const [chatThinking, setChatThinking] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const chatOutbox = useRef(createConversationOutbox(saveConversationMessage));

  // Connection state. account === null means "not connected" → gated onboarding.
  const [booting, setBooting] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Expiry / reconnect state. `expiredKind` is the whole connection-health
  // tri-state: null = healthy, "expired" = lapsed (just reconnect), "revoked" =
  // invalid (get a new token). When set, the cached shell stays visible but
  // read-only behind a reconnect banner. `reconnectOpen` swaps in the paste flow;
  // `onboardingUpgrade` shows the skippable durable-token step after a first
  // successful connect.
  const [expiredKind, setExpiredKind] = useState<ExpiredKind>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [onboardingUpgrade, setOnboardingUpgrade] = useState(false);
  const [onboardingClaude, setOnboardingClaude] = useState(false);
  const connectionExpired = expiredKind !== null;

  // Claude Code connection health, probed once here and shared with the
  // onboarding step, the chat banner, and Settings. `model` is the Claude alias
  // used for real generations (the connection test always uses sonnet).
  const claude = useClaudeStatus();
  const [model, setModel] = useState<ClaudeModel>("sonnet");

  // Two data domains:
  //   - localPosts: app-owned drafts + scheduled, persisted in SQLite.
  //   - published:  Instagram-owned, fetched live from the Graph API.
  const [localPosts, setLocalPosts] = useState<Post[]>([]);
  const [published, setPublished] = useState<Post[]>([]);
  const [provider, setProvider] = useState<AiProviderId>("claude");

  // Week-over-week follower change for the dashboard. Recomputed off a local
  // snapshot history (see storage.ts) since Instagram's API only exposes the
  // current count, not a trend — null until 7+ days of history accrue.
  const [followerDelta, setFollowerDelta] = useState<{
    pct: number;
    direction: "up" | "down";
  } | null>(null);

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

  // Boot: load stored token + account + local posts + the default conversation.
  // If connected, check token health first (so a token that lapsed while the
  // app was closed greets the user with the reconnect banner, not a broken
  // dashboard), then refresh live account/media in the background.
  useEffect(() => {
    (async () => {
      try {
        const [tokenResult, accountResult, postsResult, conversationResult] =
          await Promise.allSettled([
            getToken(),
            loadAccount(),
            loadPosts(),
            loadDefaultConversation(INITIAL_CHAT),
          ]);

        const token = tokenResult.status === "fulfilled" ? tokenResult.value : null;
        const account = accountResult.status === "fulfilled" ? accountResult.value : null;
        const connectionFailure =
          tokenResult.status === "rejected"
            ? tokenResult
            : accountResult.status === "rejected"
              ? accountResult
              : null;
        if (connectionFailure) {
          setConnectError(
            `Couldn't load the saved Instagram connection: ${String(connectionFailure.reason)}`,
          );
        }

        if (postsResult.status === "fulfilled") {
          setLocalPosts(postsResult.value);
        } else {
          setFetchError(`Couldn't load local posts: ${String(postsResult.reason)}`);
        }

        if (conversationResult.status === "fulfilled") {
          setChatMessages(conversationResult.value);
        } else {
          setChatNeedsRestore(true);
          setChatPersistenceError(
            `Couldn't restore conversation: ${String(conversationResult.reason)}`,
          );
        }

        if (token && account) {
          setAccessToken(token);
          setAccount(account);
          const usable = await ensureFreshToken(token);
          if (usable) void refresh(usable, account.igUserId);
        }
      } catch (error) {
        setFetchError(`Couldn't finish loading local data: ${String(error)}`);
      } finally {
        // Storage/migration failures degrade the affected feature, but must not
        // strand the whole application on its loading screen.
        setBooting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A failed boot restore is retried at the moment the user next sends. Keeping
  // the draft in the composer until this succeeds avoids answering a follow-up
  // without the durable turns it depends on.
  async function prepareChatHistory(): Promise<ChatMessage[] | null> {
    if (!chatNeedsRestore) return chatMessages;
    try {
      const restored = await loadDefaultConversation(INITIAL_CHAT);
      setChatMessages(restored);
      setChatNeedsRestore(false);
      setChatPersistenceError(null);
      return restored;
    } catch (error) {
      setChatPersistenceError(`Couldn't restore conversation: ${String(error)}`);
      return null;
    }
  }

  // Keep the follower history + dashboard delta in sync with whatever account
  // is currently loaded (cached-on-boot or freshly fetched — either way).
  useEffect(() => {
    if (!account) return;
    (async () => {
      await recordFollowerSnapshot(account.followers);
      setFollowerDelta(await getFollowerDelta(account.followers));
    })();
  }, [account?.followers]);

  // Lightweight background schedule: while connected, periodically re-check token
  // health and roll a long-lived token forward before it lapses.
  useEffect(() => {
    if (!accessToken || !account || connectionExpired) return;
    const id = setInterval(async () => {
      const usable = await ensureFreshToken(accessToken);
      if (usable) void refresh(usable, account.igUserId);
    }, REFRESH_CHECK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, account, connectionExpired]);

  // Move the app into the expired/reconnect state. `revoked` means the token is
  // invalid (password change / de-auth) rather than merely lapsed.
  function enterExpired(revoked = false) {
    setExpiredKind(revoked ? "revoked" : "expired");
  }

  // Reset all expiry/reconnect state back to healthy. Shared by connect (success)
  // and disconnect so the reset stays in one place.
  function clearExpiredState() {
    setExpiredKind(null);
    setReconnectOpen(false);
  }

  // If `e` is a Meta auth failure (code 190), enter the reconnect state and
  // report true so the caller can bail out; otherwise return false.
  function handledAsAuthError(e: unknown): boolean {
    if (e instanceof AuthError) {
      enterExpired(e.revoked);
      return true;
    }
    return false;
  }

  // Guard an action that needs a live connection. When expired, nag toward
  // reconnecting and report true so the caller bails out.
  function blockedByExpiry(action: string): boolean {
    if (connectionExpired) {
      notify(`Reconnect your Instagram account to ${action}.`, "err");
      return true;
    }
    return false;
  }

  // Consult the pure classifier for the stored expiry; refresh when eligible,
  // enter the expired state when lapsed. Returns a usable token, or null when the
  // connection can no longer be used. A refresh that fails only because the token
  // isn't eligible yet (or a transient network error) is swallowed quietly — the
  // current token keeps working and normal operation stays clean.
  async function ensureFreshToken(tok: string): Promise<string | null> {
    const expiry = await loadTokenExpiry();
    const state = classifyToken(expiry, Date.now());
    if (state === "expired") {
      enterExpired(false);
      return null;
    }
    if (state === "needs-refresh") {
      try {
        const { token: fresh, expiresIn } = await refreshToken(tok, DEFAULT_CONFIG);
        await persistToken(fresh);
        await saveTokenExpiry(Date.now() + expiresIn * 1000);
        setAccessToken(fresh);
        return fresh;
      } catch (e) {
        if (handledAsAuthError(e)) return null;
        return tok; // not eligible yet / transient — keep using the current token
      }
    }
    return tok;
  }

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
  // A Meta auth failure (code 190) means the token lapsed mid-session → drop into
  // the reconnect state rather than showing a raw "couldn't load" error.
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
      if (handledAsAuthError(e)) return;
      setFetchError(e instanceof Error ? e.message : String(e));
    }
  }

  // Connect (first run) or reconnect (after expiry) — same paste-token flow.
  async function connect(rawToken: string, isReconnect = false) {
    setConnecting(true);
    setConnectError(null);
    try {
      const acct = await resolveAccount(rawToken, DEFAULT_CONFIG);
      await persistToken(rawToken);
      await saveAccount(acct);
      // A raw pasted token carries no expires_in, so its expiry is unknown. Clear
      // any stale expiry from a previous token; the reactive code-190 path covers
      // these until a refresh gives us a real expiry to track proactively.
      await clearTokenExpiry();
      setAccessToken(rawToken);
      setAccount(acct);
      clearExpiredState();
      setFetchError(null);
      try {
        setPublished(await fetchMedia(rawToken, acct.igUserId, DEFAULT_CONFIG));
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : String(e));
      }
      // Teach the durable path only on a first connection, not on every reconnect.
      if (!isReconnect) setOnboardingUpgrade(true);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    await clearToken();
    await clearAccount();
    await clearTokenExpiry();
    setAccessToken(null);
    setAccount(null);
    setPublished([]);
    setFetchError(null);
    clearExpiredState();
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
    if (blockedByExpiry("publish")) return;
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
      if (handledAsAuthError(e)) {
        notify("Your Instagram connection expired. Reconnect to publish.", "err");
        return;
      }
      notify(e instanceof Error ? e.message : "Publish failed.", "err");
    }
  }

  async function schedulePost(when: number) {
    if (blockedByExpiry("schedule posts")) return;
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

  // Skippable durable-token step, shown once right after a first connect, then
  // chained into the skippable "Connect your AI copilot" step.
  if (onboardingUpgrade) {
    return (
      <UpgradeStep
        onDone={() => {
          setOnboardingUpgrade(false);
          setOnboardingClaude(true);
        }}
      />
    );
  }

  // Skippable AI-copilot step: detect the user's Claude Code session (or teach
  // the one-time CLI setup). Never blocks — Instagram publishing works without it.
  if (onboardingClaude) {
    return <ConnectClaudeStep conn={claude} onDone={() => setOnboardingClaude(false)} />;
  }

  // First-run gate: no account cached at all.
  if (!account) {
    return <ConnectView onConnect={connect} connecting={connecting} error={connectError} />;
  }

  // Reconnect gate: an expired connection whose banner "Reconnect" was clicked.
  // Reuses the same paste flow, in its reconnect variant with the durable nudge.
  if (reconnectOpen) {
    return (
      <ConnectView
        variant="reconnect"
        onConnect={(t) => connect(t, true)}
        connecting={connecting}
        error={connectError}
        onCancel={() => setReconnectOpen(false)}
      />
    );
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
          <ChatView
            provider={providerName}
            model={model}
            claudeConnected={claude.checking ? null : claude.connected}
            conversation={{
              messages: chatMessages,
              setMessages: setChatMessages,
              thinking: chatThinking,
              setThinking: setChatThinking,
              draft: chatDraft,
              setDraft: setChatDraft,
              persistenceError: chatPersistenceError,
              onPersistenceError: setChatPersistenceError,
              prepareHistory: prepareChatHistory,
              persistMessage: chatOutbox.current.persist,
              hasPendingMessages: chatOutbox.current.hasPending,
            }}
            onOpenSettings={() => setView("settings")}
            onUseIdea={useIdea}
          />
        ) : (
          <div className="main-inner">
            {/* Expired: keep the last-known dashboard/posts visible but read-only
                behind a reconnect banner — never a blank screen or raw error. */}
            {connectionExpired && (
              <div className="banner banner-err reconnect-banner" style={{ marginBottom: "var(--s4)" }}>
                <span>
                  {expiredKind === "revoked"
                    ? "Your Instagram token is no longer valid (it may have been revoked). Reconnect with a new token to continue."
                    : "Your Instagram connection expired. Reconnect to keep loading and publishing posts."}
                </span>
                <button className="btn btn-grad btn-sm" onClick={() => setReconnectOpen(true)}>
                  Reconnect
                </button>
              </div>
            )}

            {banner && (
              <div className={`banner banner-${banner.kind}`} style={{ marginBottom: "var(--s4)" }}>
                {banner.text}
              </div>
            )}

            {fetchError && !connectionExpired && (
              <div className="banner banner-err" style={{ marginBottom: "var(--s4)" }}>
                Couldn&apos;t load Instagram data: {fetchError}
              </div>
            )}

            <div className={connectionExpired ? "content-expired" : undefined}>
              {view === "dashboard" && (
                <DashboardView
                  account={account}
                  posts={posts}
                  followerDelta={followerDelta}
                  onNavigate={setView}
                />
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
                  expired={connectionExpired}
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
                  claude={claude}
                  activeModel={model}
                  onSelectModel={setModel}
                  onDisconnect={disconnect}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
