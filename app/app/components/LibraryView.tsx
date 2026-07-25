"use client";

import { useState } from "react";
import {
  contentDeletionConfirmation,
  groupsWithStatus,
  type ContentDeliveryGroup,
} from "@/lib/content-delivery-presentation";
import type { Post } from "@/lib/types";
import { IconLibrary, IconHeart, IconComment, IconClock, IconPlus, IconTrash } from "./icons";
import { ConfirmModal } from "./ConfirmModal";
import ContentMediaThumbnail from "./ContentMediaThumbnail";
import DeliveryStateList from "./DeliveryStateList";
import PostMediaThumbnail from "./PostMediaThumbnail";

// Drafts and scheduled work are the app's own content with its destinations.
// Published work is the platform's record, read back through its adapter, and
// has no local delivery to show.
type Tab = "draft" | "scheduled" | "published";

function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function LibraryView({
  groups,
  published,
  onEdit,
  onDelete,
  onCompose,
}: {
  groups: ContentDeliveryGroup[];
  published: Post[];
  onEdit: (contentId: string) => void;
  onDelete: (contentId: string) => Promise<void>;
  onCompose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("draft");
  const [deletingContentId, setDeletingContentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ContentDeliveryGroup | null>(null);
  const drafts = groupsWithStatus(groups, "draft");
  const scheduled = groupsWithStatus(groups, "scheduled");
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "draft", label: "Drafts", count: drafts.length },
    { id: "scheduled", label: "Scheduled", count: scheduled.length },
    { id: "published", label: "Published", count: published.length },
  ];
  const shown = tab === "draft" ? drafts : tab === "scheduled" ? scheduled : [];

  async function deleteContent(group: ContentDeliveryGroup) {
    setPendingDelete(null);
    setDeletingContentId(group.content.id);
    try {
      await onDelete(group.content.id);
    } finally {
      setDeletingContentId((current) => (current === group.content.id ? null : current));
    }
  }

  return (
    <div className="view-enter">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <div className="sub">Every draft, scheduled, and published post in one place.</div>
        </div>
        <button className="btn btn-primary" onClick={onCompose}>
          <IconPlus size={17} /> New post
        </button>
      </div>

      <div className="seg" style={{ marginBottom: "var(--s5)" }} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => setTab(t.id)}
            role="tab"
            aria-selected={tab === t.id}
          >
            {t.label}
            <span className="badge-count">{t.count}</span>
          </button>
        ))}
      </div>

      {(tab === "published" ? published.length : shown.length) === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="es-ico">
              <IconLibrary size={24} />
            </div>
            <div style={{ fontWeight: 600, color: "var(--text)" }}>Nothing here yet</div>
            <div style={{ marginTop: 4 }}>Create a post and it&apos;ll show up in this tab.</div>
          </div>
        </div>
      ) : tab === "published" ? (
        <div className="lib-grid">
          {published.map((post) => (
            <div key={post.id} className="lib-card">
              <PostMediaThumbnail className="media" post={post} />
              <div className="lc-body">
                <span className="badge badge-published">
                  <span className="badge-dot" />
                  published
                </span>
                <div className="lc-cap">
                  {post.caption || <span className="muted">No caption</span>}
                </div>
                <div className="lc-foot">
                  <span className="row" style={{ gap: 12 }}>
                    {/* A figure the platform does not report stays absent. */}
                    {typeof post.likes === "number" && (
                      <span className="row" style={{ gap: 4 }}>
                        <IconHeart size={13} /> {post.likes.toLocaleString()}
                      </span>
                    )}
                    {typeof post.comments === "number" && (
                      <span className="row" style={{ gap: 4 }}>
                        <IconComment size={13} /> {post.comments.toLocaleString()}
                      </span>
                    )}
                  </span>
                  {typeof post.publishedAt === "number" && (
                    <span className="row" style={{ gap: 4 }}>
                      <IconClock size={13} /> {fmtDate(post.publishedAt)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="lib-grid">
          {shown.map((group) => (
            <div key={group.content.id} className="lib-card">
              <ContentMediaThumbnail
                className="media"
                media={group.content.media}
                previewUrl={group.previewUrl}
              />
              <div className="lc-body">
                <div className="lc-cap">
                  {group.content.caption || <span className="muted">No caption</span>}
                </div>
                <DeliveryStateList deliveries={group.deliveries} />
                <div className="lc-foot" style={{ marginTop: 10 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <button
                      className="btn btn-subtle btn-sm"
                      onClick={() => onEdit(group.content.id)}
                      disabled={deletingContentId === group.content.id}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => setPendingDelete(group)}
                      disabled={deletingContentId !== null}
                      aria-label={
                        deletingContentId === group.content.id ? "Deleting content" : "Delete content"
                      }
                      aria-busy={deletingContentId === group.content.id}
                    >
                      <IconTrash size={13} />
                      {deletingContentId === group.content.id ? "Deleting…" : "Delete"}
                    </button>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={
            pendingDelete.deliveries.some((delivery) => delivery.status === "scheduled")
              ? "Delete scheduled content?"
              : "Delete draft?"
          }
          body={contentDeletionConfirmation(pendingDelete)}
          confirmLabel="Delete"
          onConfirm={() => deleteContent(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
