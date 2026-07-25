import { CAPTION_MAX } from "../../sidecar/app-tool-contract";
import { saveComposedContent, type StoredContent } from "./content-delivery-storage";
import { deliveryForComposerDestination, type ComposerDestination } from "./delivery-composer";
import type { Delivery } from "./social-content";

// Destination-local publishing choices the composer resolved from the media,
// such as whether a Reel also reaches the feed.
export type DeliveryPlatformOptions = Record<string, string | number | boolean>;

interface PersistInput {
  content: StoredContent;
  destinations: readonly ComposerDestination[];
  scheduledAt?: number;
  platformOptions?: DeliveryPlatformOptions;
}

async function persistContentDeliveries(input: PersistInput): Promise<Delivery[]> {
  if (!input.content.id.trim()) throw new Error("The target content must have an ID.");
  if (input.content.caption.length > CAPTION_MAX) {
    throw new Error(`The caption must be ${CAPTION_MAX} characters or fewer.`);
  }
  const deliveries = input.destinations.map((destination) => ({
    ...deliveryForComposerDestination(input.content.id, destination),
    status: typeof input.scheduledAt === "number" ? ("scheduled" as const) : ("draft" as const),
    ...(typeof input.scheduledAt === "number" ? { scheduledAt: input.scheduledAt } : {}),
    ...(input.platformOptions ? { platformOptions: input.platformOptions } : {}),
  }));
  await saveComposedContent(input.content, deliveries);
  return deliveries;
}

// Work in progress: reusable content with whatever destinations have been picked
// so far, none of them committed to a time. Zero destinations is a valid draft.
export async function saveDraftContent(input: {
  content: StoredContent;
  destinations: readonly ComposerDestination[];
  platformOptions?: DeliveryPlatformOptions;
}): Promise<Delivery[]> {
  return persistContentDeliveries(input);
}

// Committing content to a time. The future-time rule belongs here rather than in
// storage: it is what the composer's date picker promises, and an already-due
// delivery is exactly what an immediate publication creates on purpose.
export async function scheduleContent(input: {
  content: StoredContent;
  destinations: readonly ComposerDestination[];
  at: number;
  now?: number;
  platformOptions?: DeliveryPlatformOptions;
}): Promise<Delivery[]> {
  if (!Number.isFinite(input.at)) {
    throw new Error("The scheduled time must be a valid date and time.");
  }
  if (input.at <= (input.now ?? Date.now())) {
    throw new Error("The scheduled time must be in the future.");
  }
  if (input.destinations.length === 0) {
    throw new Error("Choose at least one ready destination before scheduling content.");
  }
  return persistContentDeliveries({ ...input, scheduledAt: input.at });
}

// Publishing now takes the same durable path as publishing later: the delivery
// is persisted already due, so the claim that prevents a duplicate publication
// exists before anything is sent outward.
export async function prepareImmediateDelivery(input: {
  content: StoredContent;
  destination: ComposerDestination;
  at: number;
  platformOptions?: DeliveryPlatformOptions;
}): Promise<Delivery> {
  const [delivery] = await persistContentDeliveries({
    content: input.content,
    destinations: [input.destination],
    scheduledAt: input.at,
    ...(input.platformOptions ? { platformOptions: input.platformOptions } : {}),
  });
  return delivery;
}
