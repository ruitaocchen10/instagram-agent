"use client";

import type { Account } from "@/lib/types";
import {
  IconHome,
  IconFolder,
  IconCompose,
  IconCalendar,
  IconLibrary,
  IconSettings,
  IconInstagram,
  IconChevronLeft,
  IconChevronRight,
} from "./icons";

export type ViewId = "dashboard" | "projects" | "compose" | "calendar" | "library" | "settings";

const NAV: { id: ViewId; label: string; icon: (p: { size?: number }) => React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: IconHome },
  { id: "projects", label: "Projects", icon: IconFolder },
  { id: "compose", label: "Compose", icon: IconCompose },
  { id: "calendar", label: "Calendar", icon: IconCalendar },
  { id: "library", label: "Library", icon: IconLibrary },
];

export default function Sidebar({
  view,
  onNavigate,
  account,
  counts,
  collapsed,
  onToggleCollapsed,
}: {
  view: ViewId;
  onNavigate: (v: ViewId) => void;
  account: Account;
  counts: { scheduled: number; drafts: number };
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <aside className="sidebar" id="app-sidebar">
      <button
        className="sidebar-toggle"
        type="button"
        onClick={onToggleCollapsed}
        aria-controls="app-sidebar"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
      </button>

      <div className="brand">
        <div className="logo">
          <IconInstagram size={20} />
        </div>
        <div className="brand-copy">
          <div className="name">Socialite</div>
          <div className="tag">Creator Studio</div>
        </div>
      </div>

      <nav className="nav">
        <div className="nav-label">Workspace</div>
        {NAV.map((item) => {
          const Icon = item.icon;
          const badge =
            item.id === "calendar"
              ? counts.scheduled
              : item.id === "library"
                ? counts.drafts
                : undefined;
          const accessibleLabel = badge
            ? `${item.label}, ${badge} ${item.id === "calendar" ? "scheduled post" : "draft"}${badge === 1 ? "" : "s"}`
            : item.label;
          return (
            <button
              key={item.id}
              className={`nav-item${view === item.id ? " active" : ""}`}
              onClick={() => onNavigate(item.id)}
              aria-current={view === item.id ? "page" : undefined}
              aria-label={accessibleLabel}
              title={item.label}
            >
              <Icon size={19} />
              <span>{item.label}</span>
              {badge ? <span className="badge-count">{badge}</span> : null}
            </button>
          );
        })}

        <div className="nav-label">Account</div>
        <button
          className={`nav-item${view === "settings" ? " active" : ""}`}
          onClick={() => onNavigate("settings")}
          aria-current={view === "settings" ? "page" : undefined}
          aria-label="Settings"
          title="Settings"
        >
          <IconSettings size={19} />
          <span>Settings</span>
        </button>
      </nav>

      <div className="sidebar-foot">
        <div className="account-chip">
          <div className="avatar">
            <span>{account.username.slice(0, 2).toUpperCase()}</span>
          </div>
          <div className="who">
            <div className="u">@{account.username}</div>
            <div className="s">
              <span className="dot-ok" /> Connected
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
