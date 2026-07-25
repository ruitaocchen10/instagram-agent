"use client";

import { IconInstagram } from "./icons";
import type { ViewId } from "./Sidebar";

export default function EmptyWorkspace({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  return (
    <div className="view-enter">
      <div className="card stack" style={{ maxWidth: 620, margin: "72px auto" }}>
        <div className="int-ico" style={{ background: "var(--gradient)" }}><IconInstagram size={24} /></div>
        <div>
          <h1>Start with your content</h1>
          <div className="sub" style={{ marginTop: 8 }}>
            You can explore Socialite and create drafts before connecting a destination. Add a connection when you&apos;re ready to publish.
          </div>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={() => onNavigate("settings")}>Manage connections</button>
          <button className="btn btn-ghost" onClick={() => onNavigate("projects")}>Ask the copilot</button>
        </div>
      </div>
    </div>
  );
}
