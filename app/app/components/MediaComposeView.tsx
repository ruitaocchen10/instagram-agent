"use client";

import { useState } from "react";
import { CAPTION_MAX } from "@/lib/drafts";
import {
  destinationCapabilitySummary,
  preflightComposerDestinations,
} from "@/lib/delivery-composer";
import type { StoredConnection } from "@/lib/connection-storage";
import type { LocalMediaSource, PostMedia } from "@/lib/types";
import type { PublishStage } from "@/lib/publishing";
import { canChooseLocalMedia } from "@/lib/compose-media";
import PostPreview from "./PostPreview";
import { IconBolt, IconClock, IconCheck, IconImage, IconSettings } from "./icons";

const STAGE_LABELS: Record<PublishStage, string> = {
  preparing: "Preparing media…",
  uploading: "Uploading media…",
  processing: "Instagram is processing the media…",
  publishing: "Publishing to Instagram…",
  cleanup: "Cleaning up temporary media…",
};

export default function MediaComposeView({
  username,
  mediaType,
  sourceKind,
  mediaUrl,
  localMedia,
  previewUrl,
  caption,
  shareToFeed,
  r2Configured,
  choosingLocal,
  publishingStage,
  uploadPercent,
  onMediaTypeChange,
  onSourceKindChange,
  setMediaUrl,
  setCaption,
  setShareToFeed,
  onChooseLocal,
  onConfigureR2,
  onCancelUpload,
  onPublish,
  onSchedule,
  onSaveDraft,
  connections,
  activeConnectionId,
  destinationIds,
  destinationCaptionOverrides,
  onToggleDestination,
  onDestinationCaptionOverrideChange,
  onManageDestination,
  expired = false,
}: {
  username: string;
  mediaType: PostMedia["type"];
  sourceKind: "url" | "local";
  mediaUrl: string;
  localMedia: LocalMediaSource | null;
  previewUrl: string;
  caption: string;
  shareToFeed: boolean;
  r2Configured: boolean;
  choosingLocal: boolean;
  publishingStage: PublishStage | null;
  uploadPercent: number | null;
  onMediaTypeChange: (type: PostMedia["type"]) => void;
  onSourceKindChange: (source: "url" | "local") => void;
  setMediaUrl: (value: string) => void;
  setCaption: (value: string) => void;
  setShareToFeed: (value: boolean) => void;
  onChooseLocal: () => void;
  onConfigureR2: () => void;
  onCancelUpload: () => void;
  onPublish: () => void;
  onSchedule: (when: number) => void;
  onSaveDraft: () => void;
  connections: StoredConnection[];
  activeConnectionId: string | null;
  destinationIds: string[];
  destinationCaptionOverrides: Record<string, string>;
  onToggleDestination: (connectionId: string) => void;
  onDestinationCaptionOverrideChange: (connectionId: string, caption: string) => void;
  onManageDestination: (connectionId: string) => void;
  expired?: boolean;
}) {
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const defaultDate = new Date(Date.now() + 3600_000);
  const [date, setDate] = useState(defaultDate.toISOString().slice(0, 10));
  const [time, setTime] = useState(defaultDate.toTimeString().slice(0, 5));
  const over = caption.length > CAPTION_MAX;
  const mediaReady = sourceKind === "url" ? mediaUrl.trim().length > 0 : Boolean(localMedia);
  const busy = publishingStage !== null;
  const destinations = connections
    .filter((connection) => destinationIds.includes(connection.id))
    .map((connection) => ({ connection, captionOverride: destinationCaptionOverrides[connection.id] }));
  const preflight = mediaReady
    ? preflightComposerDestinations({
        id: "composer-preview",
        caption,
        media: {
          type: mediaType === "reel" ? "video" : "image",
          source: sourceKind === "url"
            ? { kind: "url", url: mediaUrl }
            : localMedia!,
        },
      }, destinations)
    : [];
  const hasReadyDestination = preflight.some((destination) => destination.errors.length === 0);
  // The current Instagram publication path still has one credential loaded at
  // a time. Keep its outward mutation scoped to that one destination until the
  // adapter-routing migration can claim and publish every delivery separately.
  const canPublishThroughCurrentAdapter =
    destinationIds.length === 1 && destinationIds[0] === activeConnectionId;
  const canSchedule = mediaReady && !over && !busy && hasReadyDestination;
  const canPublishNow = canSchedule && canPublishThroughCurrentAdapter && !expired;
  const canAct = mode === "schedule" ? canSchedule : canPublishNow;

  function primaryAction() {
    if (mode === "now") onPublish();
    else onSchedule(new Date(`${date}T${time}`).getTime());
  }

  return (
    <div className="view-enter">
      <div className="page-head">
        <div>
          <h1>Compose</h1>
          <div className="sub">Craft an image post or Reel, then publish or schedule it.</div>
        </div>
        <button className="btn btn-ghost" onClick={onSaveDraft} disabled={!mediaReady || busy}>
          Save draft
        </button>
      </div>

      <div className="compose-grid">
        <div className="card stack">
          <div className="field">
            <label>Post type</label>
            <div className="seg" role="tablist" aria-label="Post type">
              <button
                className={mediaType === "image" ? "on" : ""}
                onClick={() => onMediaTypeChange("image")}
                role="tab"
                aria-selected={mediaType === "image"}
                disabled={busy}
              >
                Image
              </button>
              <button
                className={mediaType === "reel" ? "on" : ""}
                onClick={() => onMediaTypeChange("reel")}
                role="tab"
                aria-selected={mediaType === "reel"}
                disabled={busy}
              >
                Reel
              </button>
            </div>
          </div>

          <div className="field">
            <label>Destinations</label>
            {connections.length === 0 ? (
              <div className="hint">Add a connection in Settings before publishing. You can still save this content as a draft.</div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {connections.map((connection) => {
                  const selected = destinationIds.includes(connection.id);
                  const result = preflight.find((item) => item.connectionId === connection.id);
                  return (
                    <div className="hint" key={connection.id} style={{ padding: 10 }}>
                      <label className="row" style={{ gap: 8, cursor: busy ? "default" : "pointer" }}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => onToggleDestination(connection.id)}
                          disabled={busy || connection.health === "disconnected"}
                          aria-label={`Deliver to ${connection.displayName}`}
                        />
                        <span style={{ fontWeight: 600 }}>{connection.displayName}</span>
                        <span className="muted">{connection.platform} · {connection.health}</span>
                      </label>
                      {selected && (
                        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                          {connection.capabilities && (
                            <span className="muted">{destinationCapabilitySummary(connection.capabilities)}</span>
                          )}
                          <input
                            className="input"
                            value={destinationCaptionOverrides[connection.id] ?? ""}
                            onChange={(event) => onDestinationCaptionOverrideChange(connection.id, event.target.value)}
                            placeholder="Use base caption (optional destination override)"
                            disabled={busy}
                            aria-label={`Caption override for ${connection.displayName}`}
                          />
                          {result?.errors.map((error) => (
                            <div key={`${error.field}-${error.message}`} className="row" style={{ gap: 8, color: "var(--err)" }}>
                              <span>{error.message}</span>
                              {error.field === "connection" && <button className="btn btn-ghost btn-sm" onClick={() => onManageDestination(connection.id)}>Manage connection</button>}
                            </div>
                          ))}
                          {result && result.errors.length === 0 && <span style={{ color: "var(--ok)" }}>Ready for this destination</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {connections.length > 0 && destinationIds.length === 0 && <div className="hint">Choose at least one destination to publish or schedule.</div>}
            {destinationIds.length > 1 && <div className="hint">Scheduled deliveries publish independently through their own connection. Publish now remains scoped to the connection selected in Settings.</div>}
            {destinationIds.length === 1 && !canPublishThroughCurrentAdapter && <div className="hint">Select this connection in Settings to publish now. Scheduled deliveries use their own connection.</div>}
          </div>

          <div className="field">
            <label>Media source</label>
            <div className="seg" role="tablist" aria-label="Media source">
              <button
                className={sourceKind === "url" ? "on" : ""}
                onClick={() => onSourceKindChange("url")}
                role="tab"
                aria-selected={sourceKind === "url"}
                disabled={busy}
              >
                Public URL
              </button>
              <button
                className={sourceKind === "local" ? "on" : ""}
                onClick={() => onSourceKindChange("local")}
                role="tab"
                aria-selected={sourceKind === "local"}
                disabled={busy}
              >
                Local file
              </button>
            </div>
          </div>

          {sourceKind === "url" ? (
            <div className="field">
              <label htmlFor="media-url">{mediaType === "reel" ? "Reel URL" : "Image URL"}</label>
              <input
                id="media-url"
                className="input"
                value={mediaUrl}
                onChange={(event) => setMediaUrl(event.target.value)}
                placeholder="https://…"
                autoComplete="off"
                disabled={busy}
              />
              <div className="hint row" style={{ gap: 6 }}>
                <IconImage size={14} /> Instagram must be able to fetch this public URL.
              </div>
            </div>
          ) : (
            <div className="field">
              <label>Local {mediaType === "reel" ? "Reel" : "image"}</label>
              {mediaType === "image" && !r2Configured ? (
                <div className="hint">
                  Local images need your own Cloudflare R2 bucket for temporary staging. URLs still
                  work without it. Socialite stores the credentials in your OS keychain and removes
                  staged objects after a confirmed publish.
                  <div style={{ marginTop: 10 }}>
                    <button className="btn btn-ghost btn-sm" onClick={onConfigureR2}>
                      <IconSettings size={15} /> Configure Cloudflare R2
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    className="btn btn-ghost"
                    onClick={onChooseLocal}
                    disabled={choosingLocal || busy || !canChooseLocalMedia(mediaType, r2Configured)}
                  >
                    {choosingLocal ? "Choosing…" : localMedia ? "Replace file" : "Choose file"}
                  </button>
                  {localMedia && (
                    <div className="hint">
                      {localMedia.fileName} · {(localMedia.size / 1024 / 1024).toFixed(1)} MB
                    </div>
                  )}
                  {mediaType === "reel" && (
                    <div className="hint">
                      Compatible MP4 or MOV, 3 seconds to 15 minutes, at least 540 px wide, and up
                      to 1 GB. Local Reels upload directly to Meta and do not use R2.
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {mediaType === "reel" && (
            <label className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={shareToFeed}
                onChange={(event) => setShareToFeed(event.target.checked)}
                disabled={busy}
              />
              Share Reel to feed
            </label>
          )}

          <div className="field">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <label htmlFor="caption">Caption</label>
              <span className={`char-count${over ? " over" : ""}`}>
                {caption.length.toLocaleString()} / {CAPTION_MAX.toLocaleString()}
              </span>
            </div>
            <textarea
              id="caption"
              className="textarea"
              rows={6}
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="Write a caption, add hashtags, mention people…"
              disabled={busy}
            />
          </div>

          <div className="field">
            <label>Publishing</label>
            <div className="seg" role="tablist">
              <button className={mode === "now" ? "on" : ""} onClick={() => setMode("now")} disabled={busy}>
                <IconBolt size={16} /> Publish now
              </button>
              <button className={mode === "schedule" ? "on" : ""} onClick={() => setMode("schedule")} disabled={busy}>
                <IconClock size={16} /> Schedule
              </button>
            </div>
          </div>

          {mode === "schedule" && (
            <div className="dt-row view-enter">
              <div className="field">
                <label htmlFor="publish-date">Date</label>
                <input id="publish-date" type="date" className="input" value={date} onChange={(event) => setDate(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="publish-time">Time</label>
                <input id="publish-time" type="time" className="input" value={time} onChange={(event) => setTime(event.target.value)} />
              </div>
            </div>
          )}

          {expired && <div className="hint" style={{ color: "var(--err)" }}>Publishing is paused until you reconnect Instagram. Drafts and schedules remain local.</div>}

          {publishingStage && (
            <div className="hint" role="status">
              {STAGE_LABELS[publishingStage]}
              {uploadPercent !== null ? ` ${uploadPercent}%` : ""}
              {publishingStage === "uploading" &&
                mediaType === "reel" &&
                sourceKind === "local" && (
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 10 }} onClick={onCancelUpload}>
                  Cancel upload
                </button>
              )}
            </div>
          )}

          <div className="row row-end">
            <button className="btn btn-primary" onClick={primaryAction} disabled={!canAct}>
              {mode === "now" ? <><IconBolt size={17} /> Publish now</> : <><IconCheck size={17} /> Schedule post</>}
            </button>
          </div>
        </div>

        <div className="preview-rail">
          <PostPreview username={username} imageUrl={previewUrl} caption={caption} mediaType={mediaType} />
        </div>
      </div>
    </div>
  );
}
