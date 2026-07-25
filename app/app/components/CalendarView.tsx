"use client";

import { useState } from "react";
import type { ScheduledDelivery } from "@/lib/content-delivery-presentation";
import type { Post } from "@/lib/types";
import { IconChevronLeft, IconChevronRight, IconPlus, IconClock } from "./icons";
import ContentMediaThumbnail from "./ContentMediaThumbnail";
import PostMediaThumbnail from "./PostMediaThumbnail";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtWhen(ms: number) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()} · ${fmtTime(ms)}`;
}

// The calendar plots deliveries, not content: the same creative scheduled to two
// destinations occupies two slots, each with its own time and state. Published
// work comes from the platform itself and carries no local delivery.
export default function CalendarView({
  scheduled,
  published,
  onCompose,
}: {
  scheduled: ScheduledDelivery[];
  published: Post[];
  onCompose: () => void;
}) {
  const [cursor, setCursor] = useState(() => new Date());

  const today = new Date();
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // back up to Sunday

  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }

  const publishedOnCalendar = published.filter((post) => typeof post.publishedAt === "number");

  return (
    <div className="view-enter">
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <div className="sub">
            Scheduled posts publish only while Socialite is running (the window may be closed to
            the tray) and your machine is awake.
          </div>
        </div>
        <button className="btn btn-primary" onClick={onCompose}>
          <IconPlus size={17} /> New post
        </button>
      </div>

      <div className="cal-layout">
        <div className="cal">
          <div className="cal-head">
            <h3>
              {MONTHS[month]} {year}
            </h3>
            <div className="cal-nav">
              <button
                onClick={() => setCursor(new Date(year, month - 1, 1))}
                aria-label="Previous month"
              >
                <IconChevronLeft size={18} />
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setCursor(new Date())}>
                Today
              </button>
              <button
                onClick={() => setCursor(new Date(year, month + 1, 1))}
                aria-label="Next month"
              >
                <IconChevronRight size={18} />
              </button>
            </div>
          </div>

          <div className="cal-dow">
            {DOW.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>

          <div className="cal-grid">
            {cells.map((d, i) => {
              const inMonth = d.getMonth() === month;
              const dayDeliveries = scheduled.filter((entry) =>
                sameDay(new Date(entry.delivery.scheduledAt ?? 0), d),
              );
              const dayPublished = publishedOnCalendar.filter((post) =>
                sameDay(new Date(post.publishedAt ?? 0), d),
              );
              return (
                <div
                  key={i}
                  className={`cal-cell${inMonth ? "" : " out"}${
                    sameDay(d, today) ? " today" : ""
                  }`}
                >
                  <span className="dnum">{d.getDate()}</span>
                  {dayDeliveries.slice(0, 3).map((entry) => (
                    <button
                      key={entry.delivery.id}
                      className={`cal-pill tone-${entry.delivery.state.tone}`}
                      onClick={onCompose}
                      title={`${entry.content.caption || "Untitled content"} → ${entry.delivery.connectionName} (${entry.delivery.state.label})`}
                    >
                      <ContentMediaThumbnail
                        media={entry.content.media}
                        previewUrl={entry.previewUrl}
                      />
                      <span className="t">
                        {fmtTime(entry.delivery.scheduledAt ?? 0)} · {entry.delivery.connectionName}
                      </span>
                    </button>
                  ))}
                  {dayPublished.slice(0, 3 - Math.min(dayDeliveries.length, 3)).map((post) => (
                    <button
                      key={post.id}
                      className="cal-pill published"
                      onClick={onCompose}
                      title={post.caption || "Untitled post"}
                    >
                      <PostMediaThumbnail post={post} />
                      <span className="t">{fmtTime(post.publishedAt ?? 0)}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="card stack">
          <h3 style={{ fontSize: 16 }}>Upcoming</h3>
          {scheduled.length === 0 && <div className="muted">Nothing scheduled yet.</div>}
          <div className="queue">
            {scheduled.map((entry) => (
              <div key={entry.delivery.id} className="queue-item">
                <ContentMediaThumbnail
                  media={entry.content.media}
                  previewUrl={entry.previewUrl}
                />
                <div className="qi-c">
                  <div className="qi-t">{entry.content.caption || "Untitled content"}</div>
                  <div className="qi-dest">
                    {entry.delivery.connectionName}
                    <span className="muted"> · {entry.delivery.platformName}</span>
                  </div>
                  {entry.delivery.state.detail ? (
                    <div
                      className={
                        entry.delivery.state.tone === "pending" ? "qi-w" : "qi-error"
                      }
                    >
                      {entry.delivery.state.detail}
                    </div>
                  ) : (
                    <div className="qi-w row" style={{ gap: 5 }}>
                      <IconClock size={13} />
                      {fmtWhen(entry.delivery.scheduledAt ?? 0)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
