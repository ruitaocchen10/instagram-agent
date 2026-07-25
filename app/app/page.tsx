"use client";

import { useEffect, useRef, useState } from "react";
import Sidebar, { type ViewId } from "./components/Sidebar";
import DashboardView from "./components/DashboardView";
import ProjectsView from "./components/ProjectsView";
import MediaComposeView from "./components/MediaComposeView";
import CalendarView from "./components/CalendarView";
import LibraryView from "./components/LibraryView";
import SettingsView from "./components/SettingsView";
import ConnectView from "./components/ConnectView";
import EmptyWorkspace from "./components/EmptyWorkspace";
import ConnectClaudeStep from "./components/ConnectClaudeStep";
import { useClaudeStatus } from "@/lib/useClaudeStatus";
import type { AppToolCall, AppToolResult, ClaudeModel } from "@/lib/llm";
import { MOCK_PROVIDERS } from "@/lib/mock";
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
import { errorMessage } from "@/lib/error-message";
import { mediaForPost } from "@/lib/media";
import {
  cancelLocalReelUpload,
  chooseLocalMedia,
  cleanupOrphanedManagedMedia,
  deleteManagedMedia,
  getR2Status,
  materializeManagedMediaCopy,
  onReelUploadProgress,
  previewUrlForLocalMedia,
  testR2Connection,
  type R2Status,
  type SelectedLocalMedia,
} from "@/lib/local-media";
import { deleteLocalPost } from "@/lib/post-deletion";
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
import {
  cancelStoredDelivery,
  claimStoredDelivery,
  failStoredDelivery,
  loadStoredContent,
  loadStoredDeliveries,
  markStoredDeliveryUncertain,
  publishStoredDelivery,
  recoverInterruptedDeliveries,
  startStoredDelivery,
} from "@/lib/content-delivery-storage";
import { dueScheduledDeliveries, type Content, type Delivery } from "@/lib/social-content";
import { loadStoredConnections, markStoredConnectionDisconnected, saveStoredConnection, type StoredConnection } from "@/lib/connection-storage";
import { migrateLegacyInstagramConnection } from "@/lib/legacy-connection-migration";
import { LEGACY_INSTAGRAM_CONNECTION_ID } from "@/lib/legacy-instagram-migration";
import {
  PublishOutcomeUnknownError,
  PublishCanceledAfterContainerError,
  publishPost,
  type PublishStage,
  type PublishPostResult,
} from "@/lib/publishing";
import {
  claimScheduledPost,
  clearAccount,
  clearToken,
  clearTokenExpiry,
  clearConnectionToken,
  getFollowerDelta,
  getToken,
  getConnectionToken,
  loadAccount,
  loadPosts,
  loadSettings,
  loadTokenExpiry,
  recordFollowerSnapshot,
  recordScheduledPublishFailure,
  recordScheduledPublishCanceled,
  recordScheduledPublishUncertain,
  saveAccount,
  savePost,
  saveSettings,
  saveTokenExpiry,
  startScheduledPublish,
  setToken as persistToken,
  setConnectionToken,
  DEFAULT_SETTINGS,
  type Settings,
} from "@/lib/storage";
import type {
  Account,
  AiProviderId,
  ChatMessage,
  Post,
  PostIdea,
  PostMedia,
} from "@/lib/types";

// How often the app re-checks token health in the background and refreshes if
// the classifier says the token is eligible and approaching expiry.
const REFRESH_CHECK_MS = 15 * 60 * 1000;
const SCHEDULED_PUBLISH_CHECK_MS = 60 * 1000;
const EMPTY_R2_STATUS: R2Status = {
  configured: false,
  config: null,
  maskedAccessKeyId: null,
  error: null,
};

// Instagram publishing still consumes the legacy shape while its adapter is
// being moved behind the shared seam. The scheduler, however, selects only a
// Delivery and derives this temporary adapter input from canonical content.
function schedulerPostForDelivery(
  delivery: Delivery,
  content: Content | undefined,
  legacyPost: Post | undefined,
): Post | undefined {
  if (legacyPost) return legacyPost;
  if (!content || delivery.platform !== "instagram") return undefined;
  const media =
    content.media.type === "video"
      ? {
          type: "reel" as const,
          source: content.media.source,
          shareToFeed: delivery.platformOptions?.shareToFeed !== false,
        }
      : { type: "image" as const, source: content.media.source };
  return {
    id: content.id,
    imageUrl: media.source.kind === "url" ? media.source.url : "",
    media,
    caption: delivery.captionOverride ?? content.caption,
    status: delivery.status,
    scheduledAt: delivery.scheduledAt,
    publishedAt: delivery.publishedAt,
    publishState: delivery.publishState,
    publishError: delivery.publishError,
    publishAttemptedAt: delivery.publishAttemptedAt,
    publishAttemptCount: delivery.publishAttemptCount,
  };
}

function validateReelPreview(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let settled = false;
    const timer = window.setTimeout(() => finish("Reel metadata could not be read."), 10_000);
    function finish(error?: string) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      if (error) reject(new Error(error));
      else resolve();
    }
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
        finish("This Reel's video stream is not compatible with the local preview engine.");
      } else if (video.duration < 3 || video.duration > 15 * 60) {
        finish("Reels must be between 3 seconds and 15 minutes long.");
      } else if (video.videoWidth < 540) {
        finish("Reels must be at least 540 pixels wide.");
      } else {
        finish();
      }
    };
    video.onerror = () => finish("Choose a compatible MP4 or MOV Reel.");
    video.src = url;
  });
}

// Connection-health tri-state: null = healthy; "expired" = lapsed, just
// reconnect; "revoked" = invalid (password change / de-auth), needs a new token.
type ExpiredKind = null | "expired" | "revoked";

export default function Home() {
  const [view, setView] = useState<ViewId>("dashboard");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // Chat thread lives here, not in ProjectsView, so it persists across tab
  // switches (ProjectsView unmounts whenever another view is showing). SQLite
  // restores it on application boot. A fresh install has no projects, so the
  // workspace starts empty until the grid's "create your first project" runs.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatPersistenceError, setChatPersistenceError] = useState<string | null>(null);
  const [chatNeedsRestore, setChatNeedsRestore] = useState(false);
  const [chatThinking, setChatThinking] = useState(false);
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const [managingChatWorkspace, setManagingChatWorkspace] = useState(false);
  const composePausedInSettings = useRef(false);
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
    if (!projectId || !conversationId) return;
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, sessionId } : conversation,
      ),
    );
    await saveConversationSessionId(projectId, conversationId, sessionId);
  }

  function setActiveChatDraft(next: React.SetStateAction<string>) {
    const conversationId = activeConversationId;
    if (!conversationId) return;
    setChatDrafts((drafts) => {
      const current = drafts[conversationId] ?? "";
      const value = typeof next === "function" ? next(current) : next;
      return { ...drafts, [conversationId]: value };
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
  const [connections, setConnections] = useState<StoredConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
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
  const deliveryRecoveryCompleted = useRef(false);
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
  const [mediaType, setMediaType] = useState<PostMedia["type"]>("image");
  const [mediaSourceKind, setMediaSourceKind] = useState<"url" | "local">("url");
  const [localMedia, setLocalMedia] = useState<SelectedLocalMedia | null>(null);
  const [shareToFeed, setShareToFeed] = useState(true);
  const [r2Status, setR2Status] = useState<R2Status>(EMPTY_R2_STATUS);
  const [choosingLocalMedia, setChoosingLocalMedia] = useState(false);
  const [publishingStage, setPublishingStage] = useState<PublishStage | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [caption, setCaption] = useState("");
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ text: string; kind: "ok" | "err" } | null>(null);

  function notify(text: string, kind: "ok" | "err" = "ok") {
    setBanner({ text, kind });
  }

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    void (async () => {
      try {
        const status = await getR2Status();
        if (status.configured) {
          try {
            await testR2Connection();
          } catch (error) {
            setR2Status({
              ...status,
              configured: false,
              error: `R2 needs attention: ${String(error)}`,
            });
            return;
          }
        }
        setR2Status(status);
      } catch (error) {
        setR2Status({
          ...EMPTY_R2_STATUS,
          error: `Couldn't read R2 configuration: ${String(error)}`,
        });
      }
    })();
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void onReelUploadProgress((progress) => {
      if (localMedia?.source.assetId !== progress.assetId || progress.total <= 0) return;
      setUploadPercent(Math.min(100, Math.round((progress.uploaded / progress.total) * 100)));
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, [localMedia?.source.assetId]);

  useEffect(() => {
    const compactViewport = window.matchMedia("(max-width: 1000px)");
    const syncSidebarToViewport = (event?: MediaQueryListEvent) => {
      setSidebarCollapsed(event?.matches ?? compactViewport.matches);
    };

    syncSidebarToViewport();
    compactViewport.addEventListener("change", syncSidebarToViewport);
    return () => compactViewport.removeEventListener("change", syncSidebarToViewport);
  }, []);

  // Persist appearance only after boot has restored the settings record. This
  // prevents the initial light-mode state from overwriting a saved dark theme.
  useEffect(() => {
    if (!settingsLoaded) return;
    const next = { ...settingsRef.current, theme };
    settingsRef.current = next;
    void saveSettings(next).catch((error) => {
      notify(`Couldn't save the appearance setting: ${String(error)}`, "err");
    });
  }, [settingsLoaded, theme]);

  // Boot: load stored token, account, settings, local posts, and the active conversation workspace.
  // If connected, check token health first (so a token that lapsed while the
  // app was closed greets the user with the reconnect banner, not a broken
  // dashboard), then refresh live account/media in the background.
  useEffect(() => {
    (async () => {
      try {
        const [tokenResult, accountResult, expiryResult, connectionsResult, settingsResult, postsResult, projectWorkspaceResult] =
          await Promise.allSettled([
            getToken(),
            loadAccount(),
            loadTokenExpiry(),
            loadStoredConnections(),
            loadSettings(),
            loadPosts(),
            loadProjectWorkspace(),
          ]);

        const token = tokenResult.status === "fulfilled" ? tokenResult.value : null;
        const account = accountResult.status === "fulfilled" ? accountResult.value : null;
        let storedConnections = connectionsResult.status === "fulfilled" ? connectionsResult.value : [];
        if (token && account) {
          const legacyConnection = migrateLegacyInstagramConnection(
            account,
            expiryResult.status === "fulfilled" ? expiryResult.value : null,
            Date.now(),
          );
          await saveStoredConnection(legacyConnection);
          await setConnectionToken(legacyConnection.id, token);
          storedConnections = [
            ...storedConnections.filter((connection) => connection.id !== legacyConnection.id),
            legacyConnection,
          ];
          setSelectedConnectionId(legacyConnection.id);
        }
        setConnections(storedConnections);
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
          const hydratedPosts = await Promise.all(
            postsResult.value.map(async (post) => {
              try {
                const media = mediaForPost(post);
                if (media.source.kind !== "local") return post;
                return {
                  ...post,
                  imageUrl: await previewUrlForLocalMedia(media.source.assetId),
                };
              } catch {
                return post;
              }
            }),
          );
          setLocalPosts(hydratedPosts);
          const retainedAssetIds = postsResult.value.flatMap((post) => {
            try {
              const media = mediaForPost(post);
              return media.source.kind === "local" ? [media.source.assetId] : [];
            } catch {
              return [];
            }
          });
          void cleanupOrphanedManagedMedia(retainedAssetIds).catch(() => {});
        } else {
          setFetchError(`Couldn't load local posts: ${String(postsResult.reason)}`);
        }

        if (settingsResult.status === "fulfilled") {
          const settings = settingsResult.value ?? DEFAULT_SETTINGS;
          settingsRef.current = settings;
          setTheme(settings.theme);
        }
        setSettingsLoaded(true);

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
      const restored = await loadProjectWorkspace();
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
    if (!activeProjectId || conversationId === activeConversationId) return;
    await manageChatWorkspace("switch conversations", async () => {
      const messages = await selectConversation(activeProjectId, conversationId);
      showConversationWorkspace({ conversations, activeConversationId: conversationId, messages });
    });
  }

  // Returns the new conversation's id so the project-page composer can send its
  // first message into the freshly created chat.
  async function createChatConversation(title: string): Promise<string | null> {
    if (!activeProjectId) return null;
    let createdId: string | null = null;
    await manageChatWorkspace("create conversation", async () => {
      const created = await createConversation(activeProjectId, title);
      createdId = created.conversation.id;
      showConversationWorkspace({
        conversations: [created.conversation, ...conversations],
        activeConversationId: created.conversation.id,
        messages: created.messages,
      });
    });
    return createdId;
  }

  async function renameChatConversation(title: string) {
    if (!activeProjectId || !activeConversationId) return;
    const conversationId = activeConversationId;
    await manageChatWorkspace("rename conversation", async () => {
      const renamed = await renameConversation(activeProjectId, conversationId, title);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, ...renamed }
            : conversation,
        ),
      );
    });
  }

  async function removeChatConversation() {
    if (!activeProjectId || !activeConversationId) return;
    const deletedId = activeConversationId;
    await manageChatWorkspace("delete conversation", async () => {
      const workspace = await deleteConversation(activeProjectId, deletedId);
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
      const selected = await selectProject(projectId);
      setActiveProjectId(selected.project.id);
      setProjects((current) =>
        current.map((project) =>
          project.id === selected.project.id ? { ...project, ...selected.project } : project,
        ),
      );
      showConversationWorkspace(selected);
    });
  }

  // Returns the new project's id so the grid can open its page immediately.
  async function createChatProject(name: string): Promise<string | null> {
    let createdId: string | null = null;
    await manageChatWorkspace("create project", async () => {
      const created = await createProject(name);
      createdId = created.project.id;
      setProjects((current) => [created.project, ...current]);
      setActiveProjectId(created.project.id);
      // A new project has no chats yet — the composer starts the first one.
      showConversationWorkspace({
        conversations: [],
        activeConversationId: null,
        messages: [],
      });
    });
    return createdId;
  }

  async function renameChatProject(projectId: string, name: string) {
    await manageChatWorkspace("rename project", async () => {
      const renamed = await renameProject(projectId, name);
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId ? { ...project, ...renamed } : project,
        ),
      );
    });
  }

  async function saveChatProjectInstructions(instructions: string) {
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    await manageChatWorkspace("save project instructions", async () => {
      const updated = await updateProjectInstructions(projectId, instructions);
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId ? { ...project, ...updated } : project,
        ),
      );
    });
  }

  async function removeChatProject(projectId: string) {
    const deletedConversationIds = new Set(
      projectId === activeProjectId
        ? conversations.map((conversation) => conversation.id)
        : [],
    );
    await manageChatWorkspace("delete project", async () => {
      const workspace = await deleteProject(projectId);
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
        if (selectedConnectionId === LEGACY_INSTAGRAM_CONNECTION_ID) {
          await persistToken(fresh);
          await saveTokenExpiry(recordRefreshedTokenExpiry(Date.now(), expiresIn));
        } else if (selectedConnectionId) {
          await setConnectionToken(selectedConnectionId, fresh);
        }
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
    projects.find((project) => project.id === activeProjectId) ?? null;

  // The persistence outbox is keyed to the active conversation; a project with
  // no chat yet has no thread to persist into, so hand the view safe no-ops.
  const activeOutbox =
    activeProjectId && activeConversationId
      ? conversationOutbox(activeProjectId, activeConversationId)
      : null;

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
      if (selectedConnectionId === LEGACY_INSTAGRAM_CONNECTION_ID) await saveAccount(freshAcct);
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
      const connectionId = selectedConnectionId ?? `instagram-${acct.igUserId}`;
      if (connectionId === LEGACY_INSTAGRAM_CONNECTION_ID) {
        await persistToken(usableToken);
        await saveAccount(acct);
      }
      // Persist either Meta-confirmed expiry or a distinctly marked estimate
      // that the background lifecycle will replace after the 24-hour floor.
      if (connectionId === LEGACY_INSTAGRAM_CONNECTION_ID) await saveTokenExpiry(expiry);
      const now = Date.now();
      const connection: StoredConnection = {
        id: connectionId,
        platform: "instagram",
        externalIdentityId: acct.igUserId,
        displayName: `@${acct.username}`,
        health: "ready",
        credentialMetadata: {
          expiresAt: expiry.expiresAt,
          expirySource: expiry.source === "meta" ? "platform" : "estimated",
        },
        createdAt: connections.find((item) => item.id === connectionId)?.createdAt ?? now,
        updatedAt: now,
      };
      await setConnectionToken(connectionId, usableToken);
      await saveStoredConnection(connection);
      setConnections((current) => [...current.filter((item) => item.id !== connectionId), connection]);
      setSelectedConnectionId(connectionId);
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

  async function disconnect(connectionId = selectedConnectionId) {
    if (!connectionId) return;
    const wasSelected = connectionId === selectedConnectionId;
    await clearConnectionToken(connectionId);
    await markStoredConnectionDisconnected(connectionId, Date.now());
    setConnections((current) => current.map((connection) => connection.id === connectionId ? { ...connection, health: "disconnected", updatedAt: Date.now() } : connection));
    if (connectionId === LEGACY_INSTAGRAM_CONNECTION_ID) {
      await clearToken();
      await clearAccount();
      await clearTokenExpiry();
    }
    if (wasSelected) {
      setAccessToken(null);
      setAccount(null);
      setPublished([]);
      setFetchError(null);
      clearExpiredState();
      setSelectedConnectionId(null);
    }
    setView("settings");
  }

  async function selectConnection(connectionId: string) {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection || connection.health === "disconnected") return;
    setSelectedConnectionId(connectionId);
    if (connection.platform !== "instagram") return;
    const token = await getConnectionToken(connectionId);
    if (!token || !connection.externalIdentityId) {
      setReconnectOpen(true);
      return;
    }
    const selectedAccount = await resolveAccount(token, DEFAULT_CONFIG);
    setAccessToken(token);
    setAccount(selectedAccount);
    await refresh(token, selectedAccount.igUserId);
  }

  function composerMedia(): PostMedia {
    if (mediaSourceKind === "url") {
      const source = { kind: "url" as const, url: imageUrl };
      return mediaType === "reel"
        ? { type: "reel", source, shareToFeed }
        : { type: "image", source };
    }
    if (!localMedia) throw new Error("Choose a local media file first.");
    return mediaType === "reel"
      ? { type: "reel", source: localMedia.source, shareToFeed }
      : { type: "image", source: localMedia.source };
  }

  function composerPostFields() {
    const media = composerMedia();
    return {
      imageUrl: media.source.kind === "url" ? media.source.url : localMedia?.previewUrl ?? "",
      media,
      caption,
    };
  }

  function resetComposer() {
    setEditingPostId(null);
    setImageUrl("");
    setCaption("");
    setMediaType("image");
    setMediaSourceKind("url");
    setLocalMedia(null);
    setShareToFeed(true);
    setPublishingStage(null);
    setUploadPercent(null);
  }

  function localAssetId(post: Post | undefined): string | null {
    if (!post) return null;
    try {
      const media = mediaForPost(post);
      return media.source.kind === "local" ? media.source.assetId : null;
    } catch {
      return null;
    }
  }

  function managedAssetIsPersisted(assetId: string): boolean {
    return localPostsRef.current.some((post) => localAssetId(post) === assetId);
  }

  async function discardUnownedComposerSelection(selection = localMedia) {
    if (!selection || managedAssetIsPersisted(selection.source.assetId)) return;
    await deleteManagedMedia(selection.source.assetId).catch(() => {});
  }

  async function cleanupSupersededComposerAssets(previous: Post | undefined, next: PostMedia) {
    const retained = next.source.kind === "local" ? next.source.assetId : null;
    const candidates = new Set<string>();
    const previousAsset = localAssetId(previous);
    if (previousAsset) candidates.add(previousAsset);
    if (localMedia) candidates.add(localMedia.source.assetId);
    for (const assetId of candidates) {
      if (assetId !== retained) await deleteManagedMedia(assetId).catch(() => {});
    }
  }

  async function chooseComposerLocalMedia() {
    setChoosingLocalMedia(true);
    try {
      const selected = await chooseLocalMedia(mediaType);
      if (selected) {
        if (mediaType === "reel") {
          try {
            await validateReelPreview(selected.previewUrl);
          } catch (error) {
            await deleteManagedMedia(selected.source.assetId).catch(() => {});
            throw error;
          }
        }
        const previousSelection = localMedia;
        setLocalMedia(selected);
        if (
          previousSelection &&
          previousSelection.source.assetId !== selected.source.assetId &&
          !managedAssetIsPersisted(previousSelection.source.assetId)
        ) {
          void deleteManagedMedia(previousSelection.source.assetId).catch(() => {});
        }
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "err");
    } finally {
      setChoosingLocalMedia(false);
    }
  }

  function changeMediaType(type: PostMedia["type"]) {
    if (type === mediaType) return;
    void discardUnownedComposerSelection();
    setMediaType(type);
    setLocalMedia(null);
    setShareToFeed(true);
  }

  function changeMediaSource(kind: "url" | "local") {
    setMediaSourceKind(kind);
  }

  async function cancelComposerUpload() {
    if (!localMedia) return;
    try {
      await cancelLocalReelUpload(localMedia.source.assetId);
    } catch (error) {
      notify(`Couldn't cancel the Reel upload: ${String(error)}`, "err");
    }
  }

  function openMediaStagingSettings() {
    composePausedInSettings.current = true;
    setView("settings");
    window.setTimeout(() => {
      const section = document.getElementById("media-staging");
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
      section?.focus({ preventScroll: true });
    }, 0);
  }

  function navigate(nextView: ViewId) {
    const leavingComposer = view === "compose" && nextView !== "compose";
    const abandoningPausedComposer =
      view === "settings" && composePausedInSettings.current && nextView !== "compose";
    if (leavingComposer && nextView === "settings") {
      composePausedInSettings.current = true;
    } else if (leavingComposer || abandoningPausedComposer) {
      if (localMedia && !managedAssetIsPersisted(localMedia.source.assetId)) {
        setLocalMedia(null);
      }
      void discardUnownedComposerSelection();
      composePausedInSettings.current = false;
    } else if (view === "settings" && nextView === "compose") {
      composePausedInSettings.current = false;
    }
    setView(nextView);
  }

  function useIdea(idea: PostIdea) {
    void discardUnownedComposerSelection();
    resetComposer();
    setImageUrl(idea.imageUrl.replace("/300/300", "/600/600"));
    setCaption(idea.caption);
    setView("compose");
    notify("Idea sent to composer.");
  }

  async function editPost(p: Post) {
    const media = mediaForPost(p);
    setEditingPostId(p.id);
    setMediaType(media.type);
    setMediaSourceKind(media.source.kind);
    setShareToFeed(media.type === "reel" ? media.shareToFeed : true);
    if (media.source.kind === "url") {
      setImageUrl(media.source.url);
      setLocalMedia(null);
    } else {
      let previewUrl = p.imageUrl;
      if (!previewUrl) {
        try {
          previewUrl = await previewUrlForLocalMedia(media.source.assetId);
        } catch (error) {
          notify(`Couldn't load the local media preview: ${String(error)}`, "err");
        }
      }
      setImageUrl("");
      setLocalMedia({ source: media.source, previewUrl });
    }
    setCaption(p.caption);
    setView("compose");
  }

  function startNewPost() {
    void discardUnownedComposerSelection();
    resetComposer();
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
    const media = mediaForPost(post);
    if (media.type === "reel" && media.source.kind === "local") {
      await materializeManagedMediaCopy(media.source.assetId);
    }
    const scheduled = await persistScheduledPost(post, scheduledAt);
    reflectLocalPost(scheduled);
    return scheduled;
  }

  async function deleteApplicationPost(post: Post): Promise<void> {
    try {
      await deleteLocalPost(post);
      removeReflectedLocalPost(post.id);
      notify(post.status === "scheduled" ? "Scheduled post deleted." : "Draft deleted.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Couldn't delete the post.", "err");
    }
  }

  async function publishApplicationPost(
    post: Post,
    onProgress?: (stage: PublishStage) => void,
    claimedDelivery?: Delivery,
  ): Promise<PublishPostResult> {
    if (!accessToken || !account) {
      throw new Error("Connect an Instagram account before publishing.");
    }
    if (connectionExpired) {
      throw new Error("Reconnect your Instagram account before publishing.");
    }

    const attemptedAt = Date.now();
    let publishing = post;
    let delivery = claimedDelivery;
    if (post.status === "scheduled" && !delivery) {
      delivery = (await loadStoredDeliveries(post.id)).find(
        (candidate) => candidate.platform === "instagram",
      );
    }
    if (delivery) {
      if (delivery.publishState !== "claimed") {
        const claimed = await claimStoredDelivery(delivery, attemptedAt);
        if (!claimed) {
          throw new Error(
            "This scheduled delivery is already being published or needs its previous result checked.",
          );
        }
        delivery = claimed;
      }
      publishing = {
        ...post,
        status: delivery.status,
        scheduledAt: delivery.scheduledAt,
        publishState: delivery.publishState,
        publishError: delivery.publishError,
        publishAttemptedAt: delivery.publishAttemptedAt,
        publishAttemptCount: delivery.publishAttemptCount,
      };
      reflectLocalPost(publishing);
    } else if (post.status === "scheduled") {
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
        onProgress,
        beforePublish:
          delivery
            ? async () => {
                delivery = await startStoredDelivery(delivery!, attemptedAt);
                publishing = {
                  ...publishing,
                  publishState: delivery.publishState,
                  publishAttemptedAt: delivery.publishAttemptedAt,
                };
                reflectLocalPost(publishing);
              }
            : publishing.status === "scheduled"
            ? async () => {
                publishing = await startScheduledPublish(publishing, attemptedAt);
                reflectLocalPost(publishing);
              }
            : undefined,
      });
    } catch (error) {
      if (delivery) {
        const message = error instanceof Error ? error.message : "Scheduled publish failed.";
        try {
          delivery =
            error instanceof PublishCanceledAfterContainerError
              ? await cancelStoredDelivery(delivery, message, attemptedAt)
              : error instanceof PublishOutcomeUnknownError
              ? await markStoredDeliveryUncertain(delivery, message, attemptedAt)
              : await failStoredDelivery(delivery, message, attemptedAt);
          reflectLocalPost({
            ...publishing,
            publishState: delivery.publishState,
            publishError: delivery.publishError,
            publishAttemptedAt: delivery.publishAttemptedAt,
            publishAttemptCount: delivery.publishAttemptCount,
          });
        } catch {
          // Preserve the durable claim when recording fails.
        }
      } else if (publishing.status === "scheduled") {
        const message = error instanceof Error ? error.message : "Scheduled publish failed.";
        try {
          const recorded =
            error instanceof PublishCanceledAfterContainerError
              ? await recordScheduledPublishCanceled(publishing, message, attemptedAt)
              : error instanceof PublishOutcomeUnknownError
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

    if (delivery) {
      try {
        await publishStoredDelivery(delivery, { id: result.mediaId }, Date.now());
      } catch (error) {
        const markerError = `Instagram published this delivery, but its local success marker failed: ${String(error)}`;
        try {
          await markStoredDeliveryUncertain(delivery, markerError, attemptedAt);
        } catch {
          // The original durable claim remains and still blocks duplicate retry.
        }
        result = {
          ...result,
          cleanupError: result.cleanupError ? `${result.cleanupError}; ${markerError}` : markerError,
        };
      }
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

  async function runScheduledPublishTick(retryR2FailuresNow = false): Promise<void> {
    if (scheduledPublishTickRunning.current) return;
    scheduledPublishTickRunning.current = true;
    try {
      const now = Date.now();
      if (!deliveryRecoveryCompleted.current) {
        await recoverInterruptedDeliveries();
        deliveryRecoveryCompleted.current = true;
      }
      const contents = await loadStoredContent();
      const contentById = new Map(contents.map((content) => [content.id, content]));
      const deliveries = await loadStoredDeliveries();
      // A scheduler tick only acts for the active connection. This prevents a
      // credential selected for one destination from publishing another
      // connection's delivery while adapters are still being migrated.
      const activeDeliveries = selectedConnectionId
        ? deliveries.filter((delivery) => delivery.connectionId === selectedConnectionId)
        : [];
      const due = dueScheduledDeliveries(activeDeliveries, now);
      const retryAfterR2Connect = retryR2FailuresNow
        ? activeDeliveries.filter((delivery) => {
            if (
              delivery.status !== "scheduled" ||
              delivery.publishState !== "failed" ||
              delivery.failureKind !== "retryable" ||
              typeof delivery.scheduledAt !== "number" ||
              delivery.scheduledAt > now
            ) {
              return false;
            }
            try {
              const post = schedulerPostForDelivery(
                delivery,
                contentById.get(delivery.contentId),
                localPostsRef.current.find((candidate) => candidate.id === delivery.contentId),
              );
              if (!post) return false;
              const media = mediaForPost(post);
              return media.type === "image" && media.source.kind === "local";
            } catch {
              return false;
            }
          })
        : [];
      const selected = [
        ...due,
        ...retryAfterR2Connect.filter((delivery) => !due.some((candidate) => candidate.id === delivery.id)),
      ];
      for (const delivery of selected) {
        const post = schedulerPostForDelivery(
          delivery,
          contentById.get(delivery.contentId),
          localPostsRef.current.find((candidate) => candidate.id === delivery.contentId),
        );
        if (!post) continue;
        try {
          const claimed = await claimStoredDelivery(delivery, now);
          if (!claimed) continue;
          const result = await publishApplicationPost(post, undefined, claimed);
          notify(`Scheduled delivery published as Instagram media ${result.mediaId}.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Scheduled delivery failed.";
          notify(`Scheduled delivery failed: ${message}`, "err");
        }
      }
    } finally {
      scheduledPublishTickRunning.current = false;
    }
  }

  function handleR2StatusChange(status: R2Status) {
    const justConnected = status.configured && !r2Status.configured;
    setR2Status(status);
    if (justConnected && accessToken && account && !connectionExpired) {
      void runScheduledPublishTick(true);
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
        const currentMedia = mediaForPost(post);
        const approvalMediaUrl =
          currentMedia.source.kind === "url" ? currentMedia.source.url : "";
        if (post.caption !== call.input.caption || approvalMediaUrl !== call.input.image_url) {
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
    setPublishingStage("preparing");
    setUploadPercent(null);
    try {
      const editedPost = editingPostId
        ? localPostsRef.current.find((post) => post.id === editingPostId)
        : undefined;
      const fields = composerPostFields();
      const result = await publishApplicationPost(
        editedPost
          ? { ...editedPost, ...fields }
          : {
              id: newId(),
              ...fields,
              status: "draft",
            },
        setPublishingStage,
      );
      await cleanupSupersededComposerAssets(editedPost, fields.media);
      resetComposer();
      notify(
        result.cleanupError || result.refreshError
          ? `Published as media ${result.mediaId}, but some local data could not be refreshed.`
          : `Published to Instagram as media ${result.mediaId}.`,
      );
      setView("library");
    } catch (e) {
      setPublishingStage(null);
      setUploadPercent(null);
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
      const fields = composerPostFields();
      await scheduleApplicationPost(
        editedPost
          ? { ...editedPost, ...fields }
          : {
              id: newId(),
              ...fields,
              status: "draft",
            },
        when,
      );
      await cleanupSupersededComposerAssets(editedPost, fields.media);
      resetComposer();
      notify("Post scheduled.");
      setView("calendar");
    } catch (error) {
      notify(errorMessage(error, "Couldn't schedule the post."), "err");
    }
  }

  async function saveDraft() {
    try {
      const fields = composerPostFields();
      if (editingPostId) {
        const existing = localPostsRef.current.find((post) => post.id === editingPostId);
        if (!existing) throw new Error("This draft no longer exists.");
        const updated = { ...existing, ...fields, updatedAt: Date.now() };
        if (existing.status === "scheduled" && existing.scheduledAt) {
          await scheduleApplicationPost(updated, existing.scheduledAt);
        } else {
          if (fields.media.type === "reel" && fields.media.source.kind === "local") {
            await materializeManagedMediaCopy(fields.media.source.assetId);
          }
          await savePost(updated);
          reflectLocalPost(updated);
        }
        await cleanupSupersededComposerAssets(existing, fields.media);
      } else {
        if (fields.media.type === "reel" && fields.media.source.kind === "local") {
          await materializeManagedMediaCopy(fields.media.source.assetId);
        }
        const draft = await createDraft({ caption, media: fields.media });
        reflectLocalPost({ ...draft, imageUrl: fields.imageUrl });
        await cleanupSupersededComposerAssets(undefined, fields.media);
      }
      resetComposer();
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

  // A connection flow is user-initiated from Settings (or from an expired
  // connection), never a first-run gate. Drafting and copilot work remain
  // available without a destination.
  if (reconnectOpen) {
    return (
      <ConnectView
        variant={selectedConnectionId ? "reconnect" : "first-run"}
        onConnect={(t) => connect(t, Boolean(selectedConnectionId))}
        connecting={connecting}
        error={connectError}
        onCancel={() => setReconnectOpen(false)}
      />
    );
  }

  return (
    <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar
        view={view}
        onNavigate={navigate}
        account={account}
        counts={counts}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      <main className="main">
        {view === "projects" ? (
          // Projects owns the full viewport height (own scroll + sticky composer).
          <ProjectsView
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
              draft: activeConversationId ? chatDrafts[activeConversationId] ?? "" : "",
              setDraft: setActiveChatDraft,
              persistenceError: chatPersistenceError,
              onPersistenceError: setChatPersistenceError,
              prepareHistory: prepareChatHistory,
              persistMessage: activeOutbox?.persist ?? (async () => {}),
              rememberSessionId: rememberActiveConversationSession,
              hasPendingMessages: activeOutbox?.hasPending ?? (() => false),
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
              <div
                className={`banner banner-${banner.kind}`}
                style={{ marginBottom: "var(--s4)" }}
                role={banner.kind === "err" ? "alert" : "status"}
              >
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
              {view === "dashboard" && (account ? (
                <DashboardView
                  account={account}
                  posts={posts}
                  followerDelta={followerDelta}
                  onNavigate={setView}
                />
              ) : <EmptyWorkspace onNavigate={setView} />)}
              {view === "compose" && (
                <MediaComposeView
                  username={account?.username ?? "your destination"}
                  mediaType={mediaType}
                  sourceKind={mediaSourceKind}
                  mediaUrl={imageUrl}
                  localMedia={localMedia?.source ?? null}
                  previewUrl={mediaSourceKind === "local" ? localMedia?.previewUrl ?? "" : imageUrl}
                  caption={caption}
                  shareToFeed={shareToFeed}
                  r2Configured={r2Status.configured}
                  choosingLocal={choosingLocalMedia}
                  publishingStage={publishingStage}
                  uploadPercent={uploadPercent}
                  onMediaTypeChange={changeMediaType}
                  onSourceKindChange={changeMediaSource}
                  setMediaUrl={setImageUrl}
                  setCaption={setCaption}
                  setShareToFeed={setShareToFeed}
                  onChooseLocal={() => void chooseComposerLocalMedia()}
                  onConfigureR2={openMediaStagingSettings}
                  onCancelUpload={() => void cancelComposerUpload()}
                  onPublish={publishNow}
                  onSchedule={schedulePost}
                  onSaveDraft={saveDraft}
                  expired={connectionExpired || !account}
                />
              )}
              {view === "calendar" && (
                <CalendarView posts={posts} onCompose={startNewPost} />
              )}
              {view === "library" && (
                <LibraryView
                  posts={posts}
                  onEdit={editPost}
                  onDelete={deleteApplicationPost}
                  onCompose={startNewPost}
                />
              )}
              {view === "settings" && (
                <SettingsView
                  connections={connections}
                  selectedConnectionId={selectedConnectionId}
                  providers={providers}
                  activeProvider={provider}
                  onSelectProvider={setProvider}
                  claude={claude}
                  activeModel={model}
                  onSelectModel={setModel}
                  theme={theme}
                  onSelectTheme={setTheme}
                  onAddConnection={() => { setConnectError(null); setSelectedConnectionId(null); setReconnectOpen(true); }}
                  onSelectConnection={(id) => void selectConnection(id).catch((error) => notify(`Couldn't select connection: ${String(error)}`, "err"))}
                  onReconnect={(id) => { setSelectedConnectionId(id); setReconnectOpen(true); }}
                  onDisconnect={(id) => void disconnect(id)}
                  r2Status={r2Status}
                  onR2StatusChange={handleR2StatusChange}
                  onReturnToCompose={() => navigate("compose")}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
