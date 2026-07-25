import { appDatabase as db } from "./app-database";
import { migrateLegacyInstagramPost } from "./legacy-instagram-migration";
import type {
  Content,
  ContentMedia,
  Delivery,
  DeliveryExternalResult,
  DeliveryFailureKind,
  DeliveryPublishState,
  DeliveryStatus,
  Platform,
} from "./social-content";
import {
  claimScheduledDelivery,
  markDeliveryPublishing,
  recordDeliveryCanceled,
  recordDeliveryFailure,
  recordDeliveryOutcomeUnknown,
  recordDeliveryPublished,
} from "./social-content";
import type { Post } from "./types";

export interface StoredContent extends Content {
  createdAt: number;
  updatedAt: number;
}

type AppDatabase = Awaited<ReturnType<typeof db>>;

interface ContentRow {
  id: string;
  caption: string;
  media_json: string;
  created_at: number;
  updated_at: number;
}

interface DeliveryRow {
  id: string;
  content_id: string;
  connection_id: string;
  platform: Platform;
  caption_override: string | null;
  platform_options_json: string | null;
  status: DeliveryStatus;
  scheduled_at: number | null;
  publish_state: DeliveryPublishState | null;
  publish_error: string | null;
  failure_kind: DeliveryFailureKind | null;
  publish_attempted_at: number | null;
  publish_attempt_count: number | null;
  published_at: number | null;
  external_result_json: string | null;
}

export async function loadStoredContent(): Promise<StoredContent[]> {
  const rows = await (await db()).select<ContentRow[]>(
    "SELECT * FROM contents ORDER BY updated_at DESC",
  );
  return rows.map((row) => ({
    id: row.id,
    caption: row.caption,
    media: parseRequiredJson<ContentMedia>(row.media_json, `content ${row.id} media`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function loadStoredDeliveries(contentId?: string): Promise<Delivery[]> {
  const connection = await db();
  const rows = contentId
    ? await connection.select<DeliveryRow[]>(
        "SELECT * FROM deliveries WHERE content_id = $1 ORDER BY scheduled_at, created_at",
        [contentId],
      )
    : await connection.select<DeliveryRow[]>(
        "SELECT * FROM deliveries ORDER BY scheduled_at, created_at",
      );
  return rows.map(rowToDelivery);
}

// The composer owns reusable Content and its chosen Delivery records directly.
// Legacy Post persistence may still mirror the same content for the existing
// Library UI, but it must never become the authoritative destination list.
export async function saveComposedContent(
  content: StoredContent,
  deliveries: readonly Delivery[],
): Promise<void> {
  if (deliveries.some((delivery) => delivery.contentId !== content.id)) {
    throw new Error("Every delivery must belong to the content being saved.");
  }
  const connection = await db();
  await connection.execute(
    `INSERT INTO contents (id, caption, media_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(id) DO UPDATE SET caption = excluded.caption, media_json = excluded.media_json,
       updated_at = excluded.updated_at`,
    [content.id, content.caption, JSON.stringify(content.media), content.createdAt, content.updatedAt],
  );
  for (const delivery of deliveries) {
    await connection.execute(
      `INSERT INTO deliveries
        (id, content_id, connection_id, platform, caption_override, platform_options_json, status,
         scheduled_at, publish_state, publish_error, failure_kind, publish_attempted_at,
         publish_attempt_count, published_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
       ON CONFLICT(id) DO UPDATE SET
         caption_override = excluded.caption_override, platform_options_json = excluded.platform_options_json,
         status = excluded.status, scheduled_at = excluded.scheduled_at,
         publish_state = excluded.publish_state, publish_error = excluded.publish_error,
         failure_kind = excluded.failure_kind, publish_attempted_at = excluded.publish_attempted_at,
         publish_attempt_count = excluded.publish_attempt_count, published_at = excluded.published_at,
         updated_at = excluded.updated_at`,
      deliveryParams(delivery, content.updatedAt),
    );
  }
  const retainedIds = deliveries.map((delivery) => delivery.id);
  const placeholders = retainedIds.map((_, index) => `$${index + 2}`).join(", ");
  await connection.execute(
    `DELETE FROM deliveries WHERE content_id = $1
       AND status <> 'published' AND COALESCE(publish_state, 'idle') <> 'uncertain'
       ${retainedIds.length ? `AND id NOT IN (${placeholders})` : ""}`,
    [content.id, ...retainedIds],
  );
}

// Compatibility bridge while the composer still writes legacy Instagram-shaped
// drafts. Every local write gets a canonical Content/Delivery counterpart, so
// the delivery scheduler also covers work created after migration 9.
export async function mirrorLegacyInstagramPost(
  post: Post,
  existingConnection?: AppDatabase,
): Promise<void> {
  const { content, delivery, updatedAt } = migrateLegacyInstagramPost(post);
  const connection = existingConnection ?? (await db());
  await connection.execute(
    `INSERT OR IGNORE INTO connections (id, platform, display_name, health, created_at, updated_at)
     VALUES ($1, 'instagram', 'Existing Instagram connection', 'unknown', $2, $2)`,
    [delivery.connectionId, updatedAt],
  );
  await connection.execute(
    `INSERT INTO contents (id, caption, media_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT(id) DO UPDATE SET caption = excluded.caption, media_json = excluded.media_json,
       updated_at = excluded.updated_at`,
    [content.id, content.caption, JSON.stringify(content.media), updatedAt],
  );
  await connection.execute(
    `INSERT INTO deliveries
      (id, content_id, connection_id, platform, caption_override, platform_options_json, status,
       scheduled_at, publish_state, publish_error, failure_kind, publish_attempted_at,
       publish_attempt_count, published_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
     ON CONFLICT(id) DO UPDATE SET
       status = CASE WHEN deliveries.publish_state = 'uncertain' THEN deliveries.status ELSE excluded.status END,
       scheduled_at = CASE WHEN deliveries.publish_state = 'uncertain' THEN deliveries.scheduled_at ELSE excluded.scheduled_at END,
       publish_state = CASE WHEN deliveries.publish_state = 'uncertain' THEN deliveries.publish_state ELSE excluded.publish_state END,
       publish_error = CASE WHEN deliveries.publish_state = 'uncertain' THEN deliveries.publish_error ELSE excluded.publish_error END,
       failure_kind = CASE WHEN deliveries.publish_state = 'uncertain' THEN deliveries.failure_kind ELSE excluded.failure_kind END,
       publish_attempted_at = CASE WHEN deliveries.publish_state = 'uncertain' THEN deliveries.publish_attempted_at ELSE excluded.publish_attempted_at END,
       publish_attempt_count = CASE WHEN deliveries.publish_state = 'uncertain' THEN deliveries.publish_attempt_count ELSE excluded.publish_attempt_count END,
       published_at = CASE WHEN deliveries.publish_state = 'uncertain' THEN deliveries.published_at ELSE excluded.published_at END,
       platform_options_json = excluded.platform_options_json,
       external_result_json = deliveries.external_result_json, updated_at = excluded.updated_at`,
    deliveryParams(delivery, updatedAt),
  );
}

export async function recoverInterruptedDeliveries(): Promise<void> {
  const connection = await db();
  await connection.execute(
    `UPDATE deliveries SET publish_state = 'failed', failure_kind = 'retryable',
       publish_error = COALESCE(publish_error, 'Publishing stopped before the platform was contacted. Retrying automatically.')
     WHERE status = 'scheduled' AND publish_state = 'claimed'`,
  );
  await connection.execute(
    `UPDATE deliveries SET publish_state = 'uncertain',
       publish_error = COALESCE(publish_error, 'Publishing was interrupted before the result was recorded. Check the platform before rescheduling.')
     WHERE status = 'scheduled' AND publish_state = 'publishing'`,
  );
}

export async function claimStoredDelivery(delivery: Delivery, attemptedAt: number): Promise<Delivery | null> {
  const claimed = claimScheduledDelivery(delivery, attemptedAt);
  const result = await (await db()).execute(
    `UPDATE deliveries SET publish_state = 'claimed', publish_error = NULL, failure_kind = NULL,
       publish_attempted_at = $3, publish_attempt_count = COALESCE(publish_attempt_count, 0) + 1,
       updated_at = $3
     WHERE id = $1 AND status = 'scheduled' AND scheduled_at = $2
       AND COALESCE(publish_state, 'idle') IN ('idle', 'failed')
       AND (failure_kind IS NULL OR failure_kind = 'retryable')`,
    [delivery.id, delivery.scheduledAt!, attemptedAt],
  );
  return result.rowsAffected === 1 ? claimed : null;
}

export async function startStoredDelivery(delivery: Delivery, attemptedAt: number): Promise<Delivery> {
  const publishing = markDeliveryPublishing(delivery, attemptedAt);
  await updateStoredDeliveryState(delivery.id, ["claimed"], publishing, attemptedAt);
  return publishing;
}

export async function failStoredDelivery(
  delivery: Delivery,
  error: string,
  attemptedAt: number,
): Promise<Delivery> {
  const failed = recordDeliveryFailure(delivery, error, attemptedAt);
  await updateStoredDeliveryState(delivery.id, ["claimed", "publishing"], failed, attemptedAt);
  return failed;
}

export async function markStoredDeliveryUncertain(delivery: Delivery, error: string, attemptedAt: number): Promise<Delivery> {
  const uncertain = recordDeliveryOutcomeUnknown(delivery, error, attemptedAt);
  await updateStoredDeliveryState(delivery.id, ["claimed", "publishing"], uncertain, attemptedAt);
  return uncertain;
}

export async function cancelStoredDelivery(delivery: Delivery, error: string, attemptedAt: number): Promise<Delivery> {
  const canceled = recordDeliveryCanceled(delivery, error, attemptedAt);
  await updateStoredDeliveryState(delivery.id, ["claimed", "publishing"], canceled, attemptedAt);
  return canceled;
}

export async function publishStoredDelivery(
  delivery: Delivery,
  externalResult: DeliveryExternalResult | undefined,
  publishedAt: number,
): Promise<Delivery> {
  const published = recordDeliveryPublished(delivery, externalResult, publishedAt);
  await updateStoredDeliveryState(delivery.id, ["claimed", "publishing"], published, publishedAt);
  return published;
}

async function updateStoredDeliveryState(
  id: string,
  expectedStates: DeliveryPublishState[],
  delivery: Delivery,
  updatedAt: number,
): Promise<void> {
  const statePlaceholders = expectedStates.map((_, index) => `$${index + 12}`).join(", ");
  const result = await (await db()).execute(
    `UPDATE deliveries SET status = $2, scheduled_at = $3, publish_state = $4, publish_error = $5,
       failure_kind = $6, publish_attempted_at = $7, publish_attempt_count = $8,
       published_at = $9, external_result_json = $10, updated_at = $11
     WHERE id = $1 AND publish_state IN (${statePlaceholders})`,
    [
      id,
      delivery.status,
      delivery.scheduledAt ?? null,
      delivery.publishState ?? "idle",
      delivery.publishError ?? null,
      delivery.failureKind ?? null,
      delivery.publishAttemptedAt ?? null,
      delivery.publishAttemptCount ?? 0,
      delivery.publishedAt ?? null,
      delivery.externalResult ? JSON.stringify(delivery.externalResult) : null,
      updatedAt,
      ...expectedStates,
    ],
  );
  if (result.rowsAffected !== 1) throw new Error("The delivery no longer has the expected publishing claim.");
}

function deliveryParams(delivery: Delivery, updatedAt: number): unknown[] {
  return [
    delivery.id, delivery.contentId, delivery.connectionId, delivery.platform,
    delivery.captionOverride ?? null, delivery.platformOptions ? JSON.stringify(delivery.platformOptions) : null,
    delivery.status, delivery.scheduledAt ?? null, delivery.publishState ?? "idle",
    delivery.publishError ?? null, delivery.failureKind ?? null, delivery.publishAttemptedAt ?? null,
    delivery.publishAttemptCount ?? 0, delivery.publishedAt ?? null, updatedAt,
  ];
}

function rowToDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    contentId: row.content_id,
    connectionId: row.connection_id,
    platform: row.platform,
    status: row.status,
    ...(row.caption_override ? { captionOverride: row.caption_override } : {}),
    ...(row.platform_options_json
      ? { platformOptions: parseRequiredJson<Record<string, string | number | boolean>>(row.platform_options_json, `delivery ${row.id} options`) }
      : {}),
    ...(row.scheduled_at !== null ? { scheduledAt: row.scheduled_at } : {}),
    ...(row.publish_state ? { publishState: row.publish_state } : {}),
    ...(row.publish_error ? { publishError: row.publish_error } : {}),
    ...(row.failure_kind ? { failureKind: row.failure_kind } : {}),
    ...(row.publish_attempted_at !== null ? { publishAttemptedAt: row.publish_attempted_at } : {}),
    ...(row.publish_attempt_count !== null ? { publishAttemptCount: row.publish_attempt_count } : {}),
    ...(row.published_at !== null ? { publishedAt: row.published_at } : {}),
    ...(row.external_result_json
      ? { externalResult: parseRequiredJson<DeliveryExternalResult>(row.external_result_json, `delivery ${row.id} external result`) }
      : {}),
  };
}

function parseRequiredJson<T>(value: string, description: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored ${description} is invalid.`);
  }
}
