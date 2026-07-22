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
import ConnectClaudeStep from "./components/ConnectClaudeStep";
import { useClaudeStatus } from "@/lib/useClaudeStatus";
import type { AppToolCall, AppToolResult, ClaudeModel } from "@/lib/llm";
import { INITIAL_CHAT, MOCK_PROVIDERS } from "@/lib/mock";
import {
  createConversation,
  deleteConversation,
  renameConversation,
  saveConversationMessage,
  saveConversationSessionId,
  selectConversation,
  type ConversationSummary,
  type ConversationWorkspace,
} from "@/lib/conversation-storage";
import {
  createProject,
  deleteProject,
  loadProjectWorkspace,
  renameProject,
  selectProject,
  updateProjectInstructions,
  type ProjectSummary,
} from "@/lib/project-storage";
import { createConversationOutbox, type ConversationOutbox } from "@/lib/chat";
import { getAnalyticsForCopilot, listPostsForCopilot } from "@/lib/copilot-tools";
import { createDraft, type CreateDraftInput } from "@/lib/drafts";
import {
  AuthError,
  DEFAULT_CONFIG,
  fetchMedia,
  refreshToken,
  resolveAccount,
} from "@/lib/instagram";
import {
  classifyToken,
  estimatePastedTokenExpiry,
  recordRefreshedTokenExpiry,
} from "@/lib/token-state";
import { schedulePost as persistScheduledPost } from "@/lib/scheduling";
import { dueScheduledPosts } from "@/lib/scheduled-publisher";
import {
  PublishOutcomeUnknownError,
  publishPost,
  type PublishPostResult,
} from "@/lib/publishing";
import {
  claimScheduledPost,
  clearAccount,
  clearToken,
  clearTokenExpiry,
  getFollowerDelta,
  getToken,
  loadAccount,
  loadPosts,
  loadTokenExpiry,
  recordFollowerSnapshot,
  recordScheduledPublishFailure,
  recordScheduledPublishUncertain,
  saveAccount,
  savePost,
  saveTokenExpiry,
  startScheduledPublish,
  setToken as persistToken,
} from "@/lib/storage";
import type { Account, AiProviderId, ChatMessage, Post, PostIdea } from "@/lib/types";

// How often the app re-checks token health in the background and refreshes if
// the classifier says the token is eligible and approaching expiry.
const REFRESH_CHECK_MS = 15 * 60 * 1000;
const SCHEDULED_PUBLISH_CHECK_MS = 60 * 1000;

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
  const [conversations, setConversations] = useState<ConversationSummary[]>([
    {
      id: "default-conversation",
      title: "Content copilot",
      sessionId: null,
      createdAt: 0,
      updatedAt: 0,
    },
  ]);
  const [projects, setProjects] = useState<ProjectSummary[]>([
    {
      id: "default-project",
      name: "My Instagram",
      instructions: "",
      workspacePath: "",
      createdAt: 0,
      updatedAt: 0,
    },
  ]);
  const [activeProjectId, setActiveProjectId] = useState("default-project");
  const [activeConversationId, setActiveConversationId] = useState("default-conversation");
  const [chatPersistenceError, setChatPersistenceError] = useState<string | null>(null);
  const [chatNeedsRestore, setChatNeedsRestore] = useState(false);
  const [chatThinking, setChatThinking] = useState(false);
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const [managingChatWorkspace, setManagingChatWorkspace] = useState(false);
  const chatWorkspaceManagementPending = useRef(false);
  const chatOutboxes = useRef(new Map<string, ConversationOutbox>());

  function conversationOutbox(projectId: string, conversationId: string): ConversationOutbox {
    const existing = chatOutboxes.current.get(conversationId);
    if (existing) return existing;
    const outbox = createConversationOutbox((message) =>
      saveConversationMessage(projectId, conversationId, message),
    );
    chatOutboxes.current.set(conversationId, outbox);
    return outbox;
  }

  async function rememberActiveConversationSession(sessionId: string) {
    const projectId = activeProjectId;
    const conversationId = activeConversationId;
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, sessionId } : conversation,
      ),
    );
    await saveConversationSessionId(projectId, conversationId, sessionId);
  }

  function setActiveChatDraft(next: React.SetStateAction<string>) {
    setChatDrafts((drafts) => {
      const current = drafts[activeConversationId] ?? "";
      const value = typeof next === "function" ? next(current) : next;
      return { ...drafts, [activeConversationId]: value };
    });
  }

  function showConversationWorkspace(workspace: ConversationWorkspace) {
    setConversations(workspace.conversations);
    setActiveConversationId(workspace.activeConversationId);
    setChatMessages(workspace.messages);
    setChatNeedsRestore(false);
  }

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
  // read-only behind a reconnect banner. `reconnectOpen` swaps in the paste flow.
  const [expiredKind, setExpiredKind] = useState<ExpiredKind>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
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
  const localPostsRef = useRef(localPosts);
  const publishedRef = useRef(published);
  const scheduledPublishTickRunning = useRef(false);
  localPostsRef.current = localPosts;
  publishedRef.current = published;
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
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  function notify(text: string, kind: "ok" | "err" = "ok") {
    setBanner({ text, kind });
  }

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Boot: load stored token + account + local posts + the active conversation workspace.
  // If connected, check token health first (so a token that lapsed while the
  // app was closed greets the user with the reconnect banner, not a broken
  // dashboard), then refresh live account/media in the background.
  useEffect(() => {
    (async () => {
      try {
        const [tokenResult, accountResult, postsResult, projectWorkspaceResult] =
          await Promise.allSettled([
            getToken(),
            loadAccount(),
            loadPosts(),
            loadProjectWorkspace(INITIAL_CHAT),
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

        if (projectWorkspaceResult.status === "fulfilled") {
          setProjects(projectWorkspaceResult.value.projects);
          setActiveProjectId(projectWorkspaceResult.value.activeProjectId);
          showConversationWorkspace(projectWorkspaceResult.value);
        } else {
          setChatNeedsRestore(true);
          setChatPersistenceError(
            `Couldn't restore conversation: ${String(projectWorkspaceResult.reason)}`,
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
      const restored = await loadProjectWorkspace(INITIAL_CHAT);
      setProjects(restored.projects);
      setActiveProjectId(restored.activeProjectId);
      showConversationWorkspace(restored);
      setChatPersistenceError(null);
      return restored.messages;
    } catch (error) {
      setChatPersistenceError(`Couldn't restore conversation: ${String(error)}`);
      return null;
    }
  }

  async function switchChatConversation(conversationId: string) {
    if (conversationId === activeConversationId) return;
    await manageChatWorkspace("switch conversations", async () => {
      const messages = await selectConversation(activeProjectId, conversationId, INITIAL_CHAT);
      showConversationWorkspace({ conversations, activeConversationId: conversationId, messages });
    });
  }

  async function createChatConversation(title: string) {
    await manageChatWorkspace("create conversation", async () => {
      const created = await createConversation(activeProjectId, title, INITIAL_CHAT);
      showConversationWorkspace({
        conversations: [created.conversation, ...conversations],
        activeConversationId: created.conversation.id,
        messages: created.messages,
      });
    });
  }

  async function renameChatConversation(title: string) {
    await manageChatWorkspace("rename conversation", async () => {
      const renamed = await renameConversation(activeProjectId, activeConversationId, title);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === activeConversationId
            ? { ...conversation, ...renamed }
            : conversation,
        ),
      );
    });
  }

  async function removeChatConversation() {
    const deletedId = activeConversationId;
    await manageChatWorkspace("delete conversation", async () => {
      const workspace = await deleteConversation(activeProjectId, deletedId, INITIAL_CHAT);
      chatOutboxes.current.delete(deletedId);
      setChatDrafts((drafts) => {
        const remaining = { ...drafts };
        delete remaining[deletedId];
        return remaining;
      });
      showConversationWorkspace(workspace);
    });
  }

  async function switchChatProject(projectId: string) {
    if (projectId === activeProjectId) return;
    await manageChatWorkspace("switch projects", async () => {
      const selected = await selectProject(projectId, INITIAL_CHAT);
      setActiveProjectId(selected.project.id);
      showConversationWorkspace(selected);
    });
  }

  async function createChatProject(name: string) {
    await manageChatWorkspace("create project", async () => {
      const created = await createProject(name, INITIAL_CHAT);
      setProjects((current) => [created.project, ...current]);
      setActiveProjectId(created.project.id);
      showConversationWorkspace({
        conversations: [created.conversation],
        activeConversationId: created.conversation.id,
        messages: created.messages,
      });
    });
  }

  async function renameChatProject(name: string) {
    await manageChatWorkspace("rename project", async () => {
      const renamed = await renameProject(activeProjectId, name);
      setProjects((current) =>
        current.map((project) =>
          project.id === activeProjectId ? { ...project, ...renamed } : project,
        ),
      );
    });
  }

  async function saveChatProjectInstructions(instructions: string) {
    await manageChatWorkspace("save project instructions", async () => {
      const updated = await updateProjectInstructions(activeProjectId, instructions);
      setProjects((current) =>
        current.map((project) =>
          project.id === activeProjectId ? { ...project, ...updated } : project,
        ),
      );
    });
  }

  async function removeChatProject() {
    const deletedProjectId = activeProjectId;
    const deletedConversationIds = new Set(conversations.map((conversation) => conversation.id));
    await manageChatWorkspace("delete project", async () => {
      const workspace = await deleteProject(deletedProjectId, INITIAL_CHAT);
      for (const conversationId of deletedConversationIds) {
        chatOutboxes.current.delete(conversationId);
      }
      setChatDrafts((drafts) =>
        Object.fromEntries(
          Object.entries(drafts).filter(([conversationId]) =>
            !deletedConversationIds.has(conversationId),
          ),
        ),
      );
      setProjects(workspace.projects);
      setActiveProjectId(workspace.activeProjectId);
      showConversationWorkspace(workspace);
    });
  }

  async function manageChatWorkspace(
    action: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (chatThinking || chatWorkspaceManagementPending.current) return;
    chatWorkspaceManagementPending.current = true;
    setManagingChatWorkspace(true);
    try {
      await operation();
      setChatPersistenceError(null);
    } catch (error) {
      setChatPersistenceError(`Couldn't ${action}: ${String(error)}`);
    } finally {
      chatWorkspaceManagementPending.current = false;
      setManagingChatWorkspace(false);
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

  // The renderer stays alive when the main window is hidden to the tray, so it
  // can keep using the exact same application-level publishing operation as the
  // composer and copilot. A guard plus the durable claim prevents overlapping
  // ticks from publishing one scheduled post twice.
  useEffect(() => {
    if (!accessToken || !account || connectionExpired) return;
    void runScheduledPublishTick();
    const id = setInterval(() => void runScheduledPublishTick(), SCHEDULED_PUBLISH_CHECK_MS);
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
        await saveTokenExpiry(recordRefreshedTokenExpiry(Date.now(), expiresIn));
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
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? projects[0];

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
      const connectedAt = Date.now();
      let usableToken = rawToken;
      let expiry = estimatePastedTokenExpiry(connectedAt);
      try {
        // Older pasted tokens may already be refresh-eligible. Refreshing here
        // gives us Meta-confirmed expiry immediately; a newly issued token is
        // not eligible for 24 hours, so its expected failure keeps the estimate.
        const refreshed = await refreshToken(rawToken, DEFAULT_CONFIG);
        usableToken = refreshed.token;
        expiry = recordRefreshedTokenExpiry(Date.now(), refreshed.expiresIn);
      } catch {
        // Keep the validated token and retry once the estimated lifecycle
        // reaches Meta's 24-hour refresh floor.
      }
      await persistToken(usableToken);
      await saveAccount(acct);
      // Persist either Meta-confirmed expiry or a distinctly marked estimate
      // that the background lifecycle will replace after the 24-hour floor.
      await saveTokenExpiry(expiry);
      setAccessToken(usableToken);
      setAccount(acct);
      clearExpiredState();
      setFetchError(null);
      try {
        setPublished(await fetchMedia(usableToken, acct.igUserId, DEFAULT_CONFIG));
      } catch (e) {
        setFetchError(e instanceof Error ? e.message : String(e));
      }
      // Claude setup follows the first Instagram connection and remains
      // skippable; reconnecting Instagram does not repeat it.
      if (!isReconnect) setOnboardingClaude(true);
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
    setEditingPostId(null);
    setImageUrl(idea.imageUrl.replace("/300/300", "/600/600"));
    setCaption(idea.caption);
    setView("compose");
    notify("Idea sent to composer.");
  }

  function editPost(p: Post) {
    setEditingPostId(p.id);
    setImageUrl(p.imageUrl);
    setCaption(p.caption);
    setView("compose");
  }

  function startNewPost() {
    setEditingPostId(null);
    setImageUrl("");
    setCaption("");
    setView("compose");
  }

  function newId() {
    return `p${Date.now()}`;
  }

  // Update both React and the synchronous tool snapshot. The ref lets several
  // tool calls in one agent turn observe actions completed earlier in that turn.
  function reflectLocalPost(post: Post) {
    const next = [post, ...localPostsRef.current.filter((current) => current.id !== post.id)];
    localPostsRef.current = next;
    setLocalPosts(next);
  }

  function removeReflectedLocalPost(postId: string) {
    const next = localPostsRef.current.filter((post) => post.id !== postId);
    localPostsRef.current = next;
    setLocalPosts(next);
  }

  function reflectPublishedPosts(posts: Post[]) {
    publishedRef.current = posts;
    setPublished(posts);
  }

  async function createApplicationDraft(input: CreateDraftInput): Promise<Post> {
    const draft = await createDraft(input);
    reflectLocalPost(draft);
    setEditingPostId(draft.id);
    setImageUrl(draft.imageUrl);
    setCaption(draft.caption);
    return draft;
  }

  async function scheduleApplicationPost(post: Post, scheduledAt: number): Promise<Post> {
    const scheduled = await persistScheduledPost(post, scheduledAt);
    reflectLocalPost(scheduled);
    return scheduled;
  }

  async function publishApplicationPost(post: Post): Promise<PublishPostResult> {
    if (!accessToken || !account) {
      throw new Error("Connect an Instagram account before publishing.");
    }
    if (connectionExpired) {
      throw new Error("Reconnect your Instagram account before publishing.");
    }

    const attemptedAt = Date.now();
    let publishing = post;
    if (post.status === "scheduled") {
      const claimed = await claimScheduledPost(post, attemptedAt);
      if (!claimed) {
        throw new Error(
          "This scheduled post is already being published or needs its previous result checked.",
        );
      }
      publishing = claimed;
      reflectLocalPost(publishing);
    }

    let result: PublishPostResult;
    try {
      result = await publishPost({
        accessToken,
        igUserId: account.igUserId,
        post: publishing,
        config: DEFAULT_CONFIG,
        beforePublish:
          publishing.status === "scheduled"
            ? async () => {
                publishing = await startScheduledPublish(publishing, attemptedAt);
                reflectLocalPost(publishing);
              }
            : undefined,
      });
    } catch (error) {
      if (publishing.status === "scheduled") {
        const message = error instanceof Error ? error.message : "Scheduled publish failed.";
        try {
          const recorded =
            error instanceof PublishOutcomeUnknownError
              ? await recordScheduledPublishUncertain(publishing, message, attemptedAt)
              : await recordScheduledPublishFailure(publishing, message, attemptedAt);
          reflectLocalPost(recorded);
        } catch {
          // Preserve the `publishing` claim when recording fails. It is safer to
          // pause than to retry an outcome whose durable state is unknown.
        }
      }
      throw error;
    }

    if (result.localPostRemoved) {
      removeReflectedLocalPost(post.id);
    } else if (publishing.status === "scheduled") {
      try {
        await savePost({
          ...publishing,
          status: "published",
          scheduledAt: undefined,
          publishedAt: Date.now(),
          publishState: "idle",
          publishError: undefined,
          updatedAt: Date.now(),
        });
        removeReflectedLocalPost(post.id);
      } catch (error) {
        const markerError = `Instagram published this post, but its local success marker failed: ${String(error)}`;
        try {
          reflectLocalPost(
            await recordScheduledPublishUncertain(publishing, markerError, attemptedAt),
          );
        } catch {
          // The original durable claim remains and still blocks duplicate retry.
        }
        result = {
          ...result,
          cleanupError: result.cleanupError
            ? `${result.cleanupError}; ${markerError}`
            : markerError,
        };
      }
    }
    if (result.publishedPosts) reflectPublishedPosts(result.publishedPosts);
    return result;
  }

  async function runScheduledPublishTick(): Promise<void> {
    if (scheduledPublishTickRunning.current) return;
    scheduledPublishTickRunning.current = true;
    try {
      const due = dueScheduledPosts(localPostsRef.current, Date.now());
      for (const post of due) {
        try {
          const result = await publishApplicationPost(post);
          notify(`Scheduled post published as Instagram media ${result.mediaId}.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Scheduled publish failed.";
          notify(`Scheduled publish failed: ${message}`, "err");
        }
      }
    } finally {
      scheduledPublishTickRunning.current = false;
    }
  }

  async function executeCopilotTool(call: AppToolCall): Promise<AppToolResult> {
    switch (call.toolName) {
      case "create_draft": {
        const draft = await createApplicationDraft({
          caption: call.input.caption,
          imageUrl: call.input.image_url,
        });
        return {
          draft_id: draft.id,
          status: "draft",
          message: "Draft created and saved in the library.",
        };
      }
      case "list_posts":
        return listPostsForCopilot([...localPostsRef.current, ...publishedRef.current]);
      case "get_analytics":
        return getAnalyticsForCopilot(publishedRef.current);
      case "schedule_post": {
        const post = [...localPostsRef.current, ...publishedRef.current].find(
          (candidate) => candidate.id === call.input.post_id,
        );
        if (!post) throw new Error(`Post ${call.input.post_id} does not exist.`);
        const scheduled = await scheduleApplicationPost(post, Date.parse(call.input.scheduled_at));
        return {
          post_id: scheduled.id,
          status: "scheduled",
          scheduled_at: new Date(scheduled.scheduledAt!).toISOString(),
          message: "Post scheduled and added to the calendar.",
        };
      }
      case "publish_now": {
        const post = [...localPostsRef.current, ...publishedRef.current].find(
          (candidate) => candidate.id === call.input.post_id,
        );
        if (!post) throw new Error(`Post ${call.input.post_id} does not exist.`);
        if (post.caption !== call.input.caption || post.imageUrl !== call.input.image_url) {
          throw new Error(
            "The target post changed after it was selected. List posts again and request a new approval with the current caption and media URL.",
          );
        }
        const result = await publishApplicationPost(post);
        const warnings = [
          result.cleanupError
            ? `the local copy could not be removed: ${result.cleanupError}`
            : null,
          result.refreshError
            ? `visible post data could not be refreshed: ${result.refreshError}`
            : null,
        ].filter((warning): warning is string => Boolean(warning));
        return {
          post_id: post.id,
          media_id: result.mediaId,
          status: "published",
          message:
            warnings.length > 0
              ? `Published to Instagram as media ${result.mediaId}, but ${warnings.join("; ")}.`
              : `Published to Instagram as media ${result.mediaId}.`,
        };
      }
    }
  }

  // Real publish: create container → poll → publish, then refetch so the new
  // post shows up from Instagram (the source of truth for published posts).
  async function publishNow() {
    if (!accessToken || !account) return;
    if (blockedByExpiry("publish")) return;
    notify("Publishing to Instagram…");
    try {
      const editedPost = editingPostId
        ? localPostsRef.current.find((post) => post.id === editingPostId)
        : undefined;
      const result = await publishApplicationPost(
        editedPost
          ? { ...editedPost, imageUrl, caption }
          : {
              id: newId(),
              imageUrl,
              caption,
              status: "draft",
            },
      );
      setEditingPostId(null);
      setImageUrl("");
      setCaption("");
      notify(
        result.cleanupError || result.refreshError
          ? `Published as media ${result.mediaId}, but some local data could not be refreshed.`
          : `Published to Instagram as media ${result.mediaId}.`,
      );
      setView("library");
    } catch (e) {
      if (handledAsAuthError(e)) {
        notify("Your Instagram connection expired. Reconnect to publish.", "err");
        return;
      }
      notify(e instanceof Error ? e.message : "Publish failed.", "err");
    }
  }

  async function schedulePost(when: number) {
    try {
      const editedPost = editingPostId
        ? localPostsRef.current.find((post) => post.id === editingPostId)
        : undefined;
      await scheduleApplicationPost(
        editedPost
          ? { ...editedPost, imageUrl, caption }
          : {
              id: newId(),
              imageUrl,
              caption,
              status: "draft",
            },
        when,
      );
      setEditingPostId(null);
      setImageUrl("");
      setCaption("");
      notify("Post scheduled.");
      setView("calendar");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Couldn't schedule the post.", "err");
    }
  }

  async function saveDraft() {
    try {
      await createApplicationDraft({ imageUrl, caption });
      notify("Draft saved.");
      setView("library");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Couldn't save the draft.", "err");
    }
  }

  if (booting) {
    return (
      <div className="connect-screen">
        <div className="muted">Loading…</div>
      </div>
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
  // Reuses the same paste flow in its reconnect variant.
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
            project={{
              projects,
              activeProjectId,
              activeProject,
              onSelectProject: switchChatProject,
              onCreateProject: createChatProject,
              onRenameProject: renameChatProject,
              onDeleteProject: removeChatProject,
              onSaveInstructions: saveChatProjectInstructions,
            }}
            conversation={{
              conversations,
              activeConversationId,
              managing: managingChatWorkspace,
              messages: chatMessages,
              setMessages: setChatMessages,
              thinking: chatThinking,
              setThinking: setChatThinking,
              draft: chatDrafts[activeConversationId] ?? "",
              setDraft: setActiveChatDraft,
              persistenceError: chatPersistenceError,
              onPersistenceError: setChatPersistenceError,
              prepareHistory: prepareChatHistory,
              persistMessage: conversationOutbox(activeProjectId, activeConversationId).persist,
              rememberSessionId: rememberActiveConversationSession,
              hasPendingMessages: conversationOutbox(activeProjectId, activeConversationId).hasPending,
              onSelectConversation: switchChatConversation,
              onCreateConversation: createChatConversation,
              onRenameConversation: renameChatConversation,
              onDeleteConversation: removeChatConversation,
            }}
            onOpenSettings={() => setView("settings")}
            onUseIdea={useIdea}
            onToolCall={executeCopilotTool}
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

            <div
              className={connectionExpired && view === "dashboard" ? "content-expired" : undefined}
            >
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
                <CalendarView posts={posts} onCompose={startNewPost} />
              )}
              {view === "library" && (
                <LibraryView posts={posts} onEdit={editPost} onCompose={startNewPost} />
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
