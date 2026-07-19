"use client";

import type { ReactNode } from "react";
import type { Account, Post } from "@/lib/types";
import type { ViewId } from "./Sidebar";
import {
  IconClock,
  IconCompose,
  IconChat,
  IconCalendar,
  IconSparkle,
  IconHeart,
  IconUsers,
  IconLibrary,
  IconCheck,
  IconBolt,
  IconTrendUp,
  IconTrendDown,
} from "./icons";

function countdown(ms: number) {
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return `in ${Math.max(1, Math.round(diff / 60000))} min`;
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function fmtWhen(ms: number) {
  return new Date(ms).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ago(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function snippet(caption: string, n = 42) {
  const c = caption.trim();
  if (!c) return "Untitled post";
  return c.length > n ? `${c.slice(0, n).trimEnd()}…` : c;
}

interface ActivityItem {
  icon: ReactNode;
  text: string;
  at: number;
}

// Derive a recent-activity timeline from real posts: published posts (Instagram),
// scheduled + drafts (local), plus a top-engagement highlight. No mock data.
function buildActivity(posts: Post[]): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const p of posts) {
    if (p.status === "published" && p.publishedAt) {
      items.push({
        icon: <IconCheck size={15} />,
        text: `“${snippet(p.caption)}” published`,
        at: p.publishedAt,
      });
    } else if (p.status === "scheduled" && p.updatedAt) {
      items.push({
        icon: <IconClock size={15} />,
        text: `Scheduled “${snippet(p.caption)}”`,
        at: p.updatedAt,
      });
    } else if (p.status === "draft" && p.updatedAt) {
      items.push({
        icon: <IconLibrary size={15} />,
        text: `Draft saved: “${snippet(p.caption)}”`,
        at: p.updatedAt,
      });
    }
  }

  // Highlight the best-performing published post by likes.
  const topLiked = posts
    .filter((p) => p.status === "published" && (p.likes ?? 0) > 0 && p.publishedAt)
    .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))[0];
  if (topLiked) {
    items.push({
      icon: <IconHeart size={15} />,
      text: `“${snippet(topLiked.caption)}” hit ${topLiked.likes!.toLocaleString()} likes`,
      at: (topLiked.publishedAt ?? 0) + 1, // +1ms so it sorts just above its publish event
    });
  }

  return items.sort((a, b) => b.at - a.at).slice(0, 5);
}

export default function DashboardView({
  account,
  posts,
  followerDelta,
  onNavigate,
}: {
  account: Account;
  posts: Post[];
  followerDelta: { pct: number; direction: "up" | "down" } | null;
  onNavigate: (v: ViewId) => void;
}) {
  const scheduled = posts.filter((p) => p.status === "scheduled");
  const drafts = posts.filter((p) => p.status === "draft");
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const prevMonthStart = new Date(monthStart);
  prevMonthStart.setMonth(prevMonthStart.getMonth() - 1);
  const publishedThisMonth = posts.filter(
    (p) => p.status === "published" && (p.publishedAt ?? 0) >= monthStart.getTime(),
  );
  const publishedPrevMonth = posts.filter(
    (p) =>
      p.status === "published" &&
      (p.publishedAt ?? 0) >= prevMonthStart.getTime() &&
      (p.publishedAt ?? 0) < monthStart.getTime(),
  );
  const publishedDelta =
    publishedPrevMonth.length > 0
      ? {
          pct: Math.abs(
            ((publishedThisMonth.length - publishedPrevMonth.length) / publishedPrevMonth.length) *
              100,
          ),
          direction:
            publishedThisMonth.length >= publishedPrevMonth.length
              ? ("up" as const)
              : ("down" as const),
        }
      : null;

  const next = [...scheduled].sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const stats: {
    icon: ReactNode;
    tint: string;
    soft: string;
    val: number | string;
    lbl: string;
    delta: { pct: number; direction: "up" | "down" } | null;
    deltaLbl: string;
  }[] = [
    {
      icon: <IconClock size={14} />,
      tint: "var(--accent)",
      soft: "var(--accent-soft)",
      val: scheduled.length,
      lbl: "Scheduled",
      delta: null,
      deltaLbl: "",
    },
    {
      icon: <IconLibrary size={14} />,
      tint: "var(--text-2)",
      soft: "var(--surface-3)",
      val: drafts.length,
      lbl: "Drafts",
      delta: null,
      deltaLbl: "",
    },
    {
      icon: <IconCheck size={14} />,
      tint: "var(--ok)",
      soft: "var(--ok-soft)",
      val: publishedThisMonth.length,
      lbl: "Published this month",
      delta: publishedDelta,
      deltaLbl: "vs last month",
    },
    {
      icon: <IconUsers size={14} />,
      tint: "var(--primary)",
      soft: "var(--primary-soft)",
      val: account.followers.toLocaleString(),
      lbl: "Followers",
      delta: followerDelta,
      deltaLbl: "vs last week",
    },
  ];

  const activity = buildActivity(posts);

  return (
    <div className="view-enter">
      <div className="page-head">
        <div>
          <h1>
            {greeting}, {account.fullName.split(" ")[0]}
          </h1>
          <div className="sub">Here&apos;s what&apos;s happening with @{account.username}.</div>
        </div>
        <button className="btn btn-primary" onClick={() => onNavigate("chat")}>
          <IconSparkle size={17} /> Ask the copilot
        </button>
      </div>

      <div className="stack">
        <div className="stat-grid">
          {stats.map((s, i) => (
            <div key={i} className="stat">
              <div className="stat-head">
                <div className="ico" style={{ background: s.soft, color: s.tint }}>
                  {s.icon}
                </div>
                <div className="lbl">{s.lbl}</div>
              </div>
              <div className="val mono">{s.val}</div>
              {s.delta && (
                <div className={`delta delta-${s.delta.direction}`}>
                  <span className="delta-pill">
                    {s.delta.direction === "up" ? (
                      <IconTrendUp size={11} />
                    ) : (
                      <IconTrendDown size={11} />
                    )}
                    {s.delta.pct.toFixed(0)}%
                  </span>
                  <span className="delta-lbl">{s.deltaLbl}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="two-col">
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
              <h3 style={{ fontSize: 16 }}>Next up</h3>
              <button className="btn btn-subtle btn-sm" onClick={() => onNavigate("calendar")}>
                View calendar
              </button>
            </div>
            {next ? (
              <div className="nextup">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="thumb" src={next.imageUrl} alt="" />
                <div className="grow">
                  <span className="badge badge-scheduled">
                    <span className="badge-dot" /> {countdown(next.scheduledAt ?? 0)}
                  </span>
                  <div style={{ margin: "10px 0 8px", fontSize: 14, lineHeight: 1.45 }}>
                    {next.caption}
                  </div>
                  <div className="muted mono" style={{ fontSize: 12.5 }}>
                    {fmtWhen(next.scheduledAt ?? 0)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="muted">No posts scheduled. Compose one to fill your queue.</div>
            )}

            <div className="quick-actions" style={{ marginTop: 20 }}>
              <button className="qa" onClick={() => onNavigate("chat")}>
                <IconChat size={20} />
                <div>
                  <div className="qa-t">Plan with AI</div>
                  <div className="qa-d">Brainstorm and draft posts</div>
                </div>
              </button>
              <button className="qa" onClick={() => onNavigate("compose")}>
                <IconBolt size={20} />
                <div>
                  <div className="qa-t">Compose a post</div>
                  <div className="qa-d">Publish now or schedule</div>
                </div>
              </button>
            </div>
          </div>

          <div className="card">
            <h3 style={{ fontSize: 16, marginBottom: 12 }}>Recent activity</h3>
            {activity.length ? (
              <ul className="activity" style={{ margin: 0, padding: 0 }}>
                {activity.map((a, i) => (
                  <li key={i}>
                    <span className="a-ico">{a.icon}</span>
                    <span style={{ fontSize: 13.5 }}>{a.text}</span>
                    <span className="a-time">{ago(a.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">No activity yet — publish or schedule a post to get started.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
