"use client";

import { useState } from "react";
import type { Post } from "@/lib/types";
import { IconChevronLeft, IconChevronRight, IconPlus, IconClock } from "./icons";

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

export default function CalendarView({
  posts,
  onCompose,
}: {
  posts: Post[];
  onCompose: () => void;
}) {
  const [cursor, setCursor] = useState(() => new Date());

  const dated = posts.filter((p) => p.scheduledAt || p.publishedAt);
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

  const upcoming = dated
    .filter((p) => p.status === "scheduled")
    .sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));

  function postsOn(day: Date) {
    return dated.filter((p) => sameDay(new Date(p.scheduledAt ?? p.publishedAt ?? 0), day));
  }

  return (
    <div className="view-enter">
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <div className="sub">Your content pipeline at a glance.</div>
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
              const dayPosts = postsOn(d);
              return (
                <div
                  key={i}
                  className={`cal-cell${inMonth ? "" : " out"}${
                    sameDay(d, today) ? " today" : ""
                  }`}
                >
                  <span className="dnum">{d.getDate()}</span>
                  {dayPosts.slice(0, 3).map((p) => (
                    <button
                      key={p.id}
                      className={`cal-pill${p.status === "published" ? " published" : ""}`}
                      onClick={onCompose}
                      title={p.caption || "Untitled post"}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.imageUrl} alt="" />
                      <span className="t">
                        {fmtTime(p.scheduledAt ?? p.publishedAt ?? 0)}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="card stack">
          <h3 style={{ fontSize: 16 }}>Upcoming</h3>
          {upcoming.length === 0 && <div className="muted">Nothing scheduled yet.</div>}
          <div className="queue">
            {upcoming.map((p) => (
              <div key={p.id} className="queue-item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.imageUrl} alt="" />
                <div className="qi-c">
                  <div className="qi-t">{p.caption || "Untitled post"}</div>
                  <div className="qi-w row" style={{ gap: 5 }}>
                    <IconClock size={13} />
                    {fmtWhen(p.scheduledAt ?? 0)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
