import { platformAdapterFor } from "./platforms/registry";
import {
  validateDelivery,
  type Connection,
  type Content,
  type ContentMedia,
  type Delivery,
  type DeliveryCapabilities,
  type DeliveryValidationError,
  type PlatformAdapter,
  displayPlatformName,
} from "./social-content";

export interface ComposerDestination {
  connection: Connection;
  captionOverride?: string;
}

export interface DestinationPreflight {
  connectionId: string;
  errors: DeliveryValidationError[];
}

// A destination is publishable only when the registry has an adapter for its
// platform. The connection's own snapshot still wins on capabilities, so the
// composer explains the limits that were recorded for that destination.
export function adapterForComposerDestination(
  connection: Pick<Connection, "platform" | "capabilities">,
): PlatformAdapter | undefined {
  const adapter = platformAdapterFor(connection.platform);
  if (!adapter) return undefined;
  return {
    platform: adapter.platform,
    capabilities: connection.capabilities ?? adapter.capabilities,
  };
}

export function deliveryForComposerDestination(
  contentId: string,
  destination: ComposerDestination,
): Delivery {
  return {
    id: `draft-${contentId}-${destination.connection.id}`,
    contentId,
    connectionId: destination.connection.id,
    platform: destination.connection.platform,
    status: "draft",
    ...(destination.captionOverride?.trim()
      ? { captionOverride: destination.captionOverride.trim() }
      : {}),
  };
}

export function preflightComposerDestinations(
  content: Pick<Content, "id" | "caption"> & { media: ContentMedia },
  destinations: readonly ComposerDestination[],
): DestinationPreflight[] {
  return destinations.map((destination) => {
    const adapter = adapterForComposerDestination(destination.connection);
    if (!adapter) {
      return {
        connectionId: destination.connection.id,
        errors: [{
          field: "connection",
          message: `${displayPlatformName(destination.connection.platform)} is not available for publishing yet.`,
        }],
      };
    }
    if (destination.connection.health !== "ready") {
      return {
        connectionId: destination.connection.id,
        errors: [{
          field: "connection",
          message: `${destination.connection.displayName} needs to be reconnected before publishing.`,
        }],
      };
    }
    return {
      connectionId: destination.connection.id,
      errors: validateDelivery(content, deliveryForComposerDestination(content.id, destination), adapter),
    };
  });
}

export function destinationCapabilitySummary(capabilities: DeliveryCapabilities): string {
  return `${capabilities.mediaTypes.join(" and ")} · ${capabilities.maxCaptionLength.toLocaleString()} character caption limit`;
}
