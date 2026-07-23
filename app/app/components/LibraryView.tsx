"use client";

import { useState } from "react";
import { postDeletionConfirmation } from "@/lib/post-deletion";
import type { Post, PostStatus } from "@/lib/types";
import { IconLibrary, IconHeart, IconComment, IconClock, IconPlus, IconTrash } from "./icons";
import { ConfirmModal } from "./ConfirmModal";
import PostMediaThumbnail from "./PostMediaThumbnail";

type Tab = PostStatus;

const TABS: { id: Tab; label: string }[] = [
  { id: "draft", label: "Drafts" },
  { id: "scheduled", label: "Scheduled" },
  { id: "published", label: "Published" },
];

function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function LibraryView({
  posts,
  onEdit,
  onDelete,
  onCompose,
}: {
  posts: Post[];
  onEdit: (p: Post) => void;
  onDelete: (p: Post) => Promise<void>;
  onCompose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("draft");
  const [deletingPostId, setDeletingPostId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Post | null>(null);
  const shown = posts.filter((p) => p.status === tab);

  async function deletePost(post: Post) {
    setPendingDelete(null);
    setDeletingPostId(post.id);
    try {
      await onDelete(post);
    } finally {
      setDeletingPostId((current) => (current === post.id ? null : current));
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
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => setTab(t.id)}
            role="tab"
            aria-selected={tab === t.id}
          >
            {t.label}
            <span className="badge-count">{posts.filter((p) => p.status === t.id).length}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="es-ico">
              <IconLibrary size={24} />
            </div>
            <div style={{ fontWeight: 600, color: "var(--text)" }}>Nothing here yet</div>
            <div style={{ marginTop: 4 }}>Create a post and it&apos;ll show up in this tab.</div>
          </div>
        </div>
      ) : (
        <div className="lib-grid">
          {shown.map((p) => (
            <div key={p.id} className="lib-card">
              <PostMediaThumbnail className="media" post={p} />
              <div className="lc-body">
                <span className={`badge badge-${p.status}`}>
                  <span className="badge-dot" />
                  {p.status}
                </span>
                <div className="lc-cap">{p.caption || <span className="muted">No caption</span>}</div>
                <div className="lc-foot">
                  {p.status === "published" ? (
                    <span className="row" style={{ gap: 12 }}>
                      <span className="row" style={{ gap: 4 }}>
                        <IconHeart size={13} /> {p.likes?.toLocaleString()}
                      </span>
                      <span className="row" style={{ gap: 4 }}>
                        <IconComment size={13} /> {p.comments}
                      </span>
                    </span>
                  ) : p.status === "scheduled" ? (
                    <span className="row" style={{ gap: 4 }}>
                      <IconClock size={13} /> {fmtDate(p.scheduledAt ?? 0)}
                    </span>
                  ) : (
                    <span>Draft</span>
                  )}
                  {p.status !== "published" && (
                    <span className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-subtle btn-sm"
                        onClick={() => onEdit(p)}
                        disabled={deletingPostId === p.id}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => setPendingDelete(p)}
                        disabled={deletingPostId !== null}
                        aria-label={
                          deletingPostId === p.id ? `Deleting ${p.status}` : `Delete ${p.status}`
                        }
                        aria-busy={deletingPostId === p.id}
                      >
                        <IconTrash size={13} />
                        {deletingPostId === p.id ? "Deleting…" : "Delete"}
                      </button>
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {pendingDelete && (
        <ConfirmModal
          title={pendingDelete.status === "scheduled" ? "Delete scheduled post?" : "Delete draft?"}
          body={postDeletionConfirmation(pendingDelete)}
          confirmLabel="Delete"
          onConfirm={() => deletePost(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
