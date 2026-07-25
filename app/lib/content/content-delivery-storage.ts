import { appDatabase as db } from "../persistence/app-database";
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

export interface StoredContent extends Content {
  createdAt: number;
  updatedAt: number;
}

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
// This is the only authoritative destination list: nothing mirrors it, so a
// write that loses a destination here loses it outright.
export async function saveComposedContent(
  content: StoredContent,
  deliveries: readonly Delivery[],
): Promise<void> {
  if (deliveries.some((delivery) => delivery.contentId !== content.id)) {
    throw new Error("Every delivery must belong to the content being saved.");
  }
  const connection = await db();
  // A destination that already holds a publishing claim is mid-flight. Rewriting
  // its row would either clobber that claim or delete it outright, and either
  // one reopens the duplicate-publish window the claim exists to close.
  if (await hasPublishingClaim(content.id)) {
    throw new Error("A destination is already publishing this content, so it cannot be edited.");
  }
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

// Whether any destination for this content is mid-publication. The durable
// claim, not an in-memory status, is what makes this answer trustworthy.
async function hasPublishingClaim(contentId: string): Promise<boolean> {
  const rows = await (await db()).select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM deliveries WHERE content_id = $1 AND publish_state IN ('claimed', 'publishing')",
    [contentId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

// Content and its deliveries are removed together: a delivery outlives its
// content only as an orphan the creator can no longer see or cancel. A delivery
// already claimed for publishing keeps the whole content alive, because the
// durable claim is what stops a second attempt. Reports whether anything was
// removed, so a caller can tell a deletion from a no-op on content that is
// already gone.
export async function deleteStoredContent(contentId: string): Promise<boolean> {
  const connection = await db();
  if (await hasPublishingClaim(contentId)) {
    throw new Error("A destination is already publishing this content, so it cannot be deleted.");
  }
  await connection.execute("DELETE FROM deliveries WHERE content_id = $1", [contentId]);
  const result = await connection.execute("DELETE FROM contents WHERE id = $1", [contentId]);
  return result.rowsAffected > 0;
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
  failureKind: DeliveryFailureKind = "retryable",
): Promise<Delivery> {
  const failed = recordDeliveryFailure(delivery, error, attemptedAt, failureKind);
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
