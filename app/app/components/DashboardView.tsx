"use client";

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

export default function DashboardView({
  account,
  posts,
  onNavigate,
}: {
  account: Account;
  posts: Post[];
  onNavigate: (v: ViewId) => void;
}) {
  const scheduled = posts.filter((p) => p.status === "scheduled");
  const drafts = posts.filter((p) => p.status === "draft");
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const publishedThisMonth = posts.filter(
    (p) => p.status === "published" && (p.publishedAt ?? 0) >= monthStart.getTime(),
  );

  const next = [...scheduled].sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0))[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const stats = [
    {
      icon: <IconClock size={18} />,
      tint: "var(--accent)",
      soft: "var(--accent-soft)",
      val: scheduled.length,
      lbl: "Scheduled",
    },
    {
      icon: <IconLibrary size={18} />,
      tint: "var(--text-2)",
      soft: "var(--surface-3)",
      val: drafts.length,
      lbl: "Drafts",
    },
    {
      icon: <IconCheck size={18} />,
      tint: "var(--ok)",
      soft: "var(--ok-soft)",
      val: publishedThisMonth.length,
      lbl: "Published this month",
    },
    {
      icon: <IconUsers size={18} />,
      tint: "var(--primary)",
      soft: "var(--primary-soft)",
      val: account.followers.toLocaleString(),
      lbl: "Followers",
    },
  ];

  const activity = [
    { icon: <IconSparkle size={15} />, text: "Copilot drafted 3 post ideas", time: "2h" },
    { icon: <IconCheck size={15} />, text: "“River crossings 101” published", time: "2d" },
    { icon: <IconClock size={15} />, text: "Scheduled “Sunrise miles”", time: "3d" },
    { icon: <IconHeart size={15} />, text: "“Desert dawn patrol” hit 1.2k likes", time: "9d" },
  ];

  return (
    <div className="view-enter">
      <div className="page-head">
        <div>
          <h1>
            {greeting}, {account.fullName.split(" ")[0]}
          </h1>
          <div className="sub">Here&apos;s what&apos;s happening with @{account.username}.</div>
        </div>
        <button className="btn btn-grad" onClick={() => onNavigate("chat")}>
          <IconSparkle size={17} /> Ask the copilot
        </button>
      </div>

      <div className="stack">
        <div className="stat-grid">
          {stats.map((s, i) => (
            <div key={i} className="stat">
              <div className="ico" style={{ background: s.soft, color: s.tint }}>
                {s.icon}
              </div>
              <div className="val mono">{s.val}</div>
              <div className="lbl">{s.lbl}</div>
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
            <ul className="activity" style={{ margin: 0, padding: 0 }}>
              {activity.map((a, i) => (
                <li key={i}>
                  <span className="a-ico">{a.icon}</span>
                  <span style={{ fontSize: 13.5 }}>{a.text}</span>
                  <span className="a-time">{a.time}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
