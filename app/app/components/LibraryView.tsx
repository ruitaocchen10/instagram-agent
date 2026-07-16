"use client";

import { useState } from "react";
import type { Post, PostStatus } from "@/lib/types";
import { IconLibrary, IconHeart, IconComment, IconClock, IconPlus } from "./icons";

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
  onCompose,
}: {
  posts: Post[];
  onEdit: (p: Post) => void;
  onCompose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("draft");
  const shown = posts.filter((p) => p.status === tab);

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
            <span className="badge-count mono">{posts.filter((p) => p.status === t.id).length}</span>
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="media" src={p.imageUrl} alt="" />
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
                    <button className="btn btn-subtle btn-sm" onClick={() => onEdit(p)}>
                      Edit
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
