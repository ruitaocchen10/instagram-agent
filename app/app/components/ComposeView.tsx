"use client";

import { useState } from "react";
import PostPreview from "./PostPreview";
import { IconBolt, IconClock, IconCheck, IconImage } from "./icons";

const CAPTION_MAX = 2200;

export default function ComposeView({
  username,
  imageUrl,
  caption,
  setImageUrl,
  setCaption,
  onPublish,
  onSchedule,
  onSaveDraft,
  expired = false,
}: {
  username: string;
  imageUrl: string;
  caption: string;
  setImageUrl: (v: string) => void;
  setCaption: (v: string) => void;
  onPublish: () => void;
  onSchedule: (when: number) => void;
  onSaveDraft: () => void;
  expired?: boolean;
}) {
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const defaultDate = new Date(Date.now() + 3600_000);
  const [date, setDate] = useState(defaultDate.toISOString().slice(0, 10));
  const [time, setTime] = useState(defaultDate.toTimeString().slice(0, 5));

  const over = caption.length > CAPTION_MAX;
  const canAct = imageUrl.trim().length > 0 && !over && !expired;

  function primaryAction() {
    if (mode === "now") {
      onPublish();
    } else {
      const when = new Date(`${date}T${time}`).getTime();
      onSchedule(when);
    }
  }

  return (
    <div className="view-enter">
      <div className="page-head">
        <div>
          <h1>Compose</h1>
          <div className="sub">Craft a post, preview it live, then publish or schedule.</div>
        </div>
        <button className="btn btn-ghost" onClick={onSaveDraft} disabled={!imageUrl.trim()}>
          Save draft
        </button>
      </div>

      <div className="compose-grid">
        <div className="card stack">
          <div className="field">
            <label htmlFor="imgurl">Image URL</label>
            <input
              id="imgurl"
              className="input"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://…"
              autoComplete="off"
            />
            <div className="hint row" style={{ gap: 6 }}>
              <IconImage size={14} />
              Instagram fetches media from a public URL — local files aren&apos;t supported by the
              API.
            </div>
          </div>

          <div className="field">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <label htmlFor="cap">Caption</label>
              <span className={`char-count${over ? " over" : ""}`}>
                {caption.length.toLocaleString()} / {CAPTION_MAX.toLocaleString()}
              </span>
            </div>
            <textarea
              id="cap"
              className="textarea"
              rows={6}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write a caption, add hashtags, mention people…"
            />
          </div>

          <div className="field">
            <label>Publishing</label>
            <div className="seg" role="tablist">
              <button
                className={mode === "now" ? "on" : ""}
                onClick={() => setMode("now")}
                role="tab"
                aria-selected={mode === "now"}
              >
                <IconBolt size={16} /> Publish now
              </button>
              <button
                className={mode === "schedule" ? "on" : ""}
                onClick={() => setMode("schedule")}
                role="tab"
                aria-selected={mode === "schedule"}
              >
                <IconClock size={16} /> Schedule
              </button>
            </div>
          </div>

          {mode === "schedule" && (
            <div className="dt-row view-enter">
              <div className="field">
                <label htmlFor="d">Date</label>
                <input
                  id="d"
                  type="date"
                  className="input"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="t">Time</label>
                <input
                  id="t"
                  type="time"
                  className="input"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
            </div>
          )}

          {expired && (
            <div className="hint" style={{ color: "var(--err)" }}>
              Publishing and scheduling are paused until you reconnect Instagram. You can still save
              drafts.
            </div>
          )}

          <div className="row row-end">
            <button className="btn btn-primary" onClick={primaryAction} disabled={!canAct}>
              {mode === "now" ? (
                <>
                  <IconBolt size={17} /> Publish now
                </>
              ) : (
                <>
                  <IconCheck size={17} /> Schedule post
                </>
              )}
            </button>
          </div>
        </div>

        <div className="preview-rail">
          <div className="cap">Live preview</div>
          <PostPreview username={username} imageUrl={imageUrl} caption={caption} />
        </div>
      </div>
    </div>
  );
}
