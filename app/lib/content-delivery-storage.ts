import { appDatabase as db } from "./app-database";
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
