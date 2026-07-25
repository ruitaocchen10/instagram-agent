import type { StoredConnection } from "./connection-storage";
import type { StoredContent } from "./content-delivery-storage";
import type { Delivery } from "./social-content";

export interface ContentDeliveryGroup {
  content: StoredContent;
  deliveries: Array<Delivery & { connectionName: string }>;
}

// UI consumers deal in reusable content with its destination-local state,
// rather than reconstructing a singleton Instagram post for every surface.
export function groupContentDeliveries(
  contents: readonly StoredContent[],
  deliveries: readonly Delivery[],
  connections: readonly StoredConnection[],
): ContentDeliveryGroup[] {
  const connectionNames = new Map(connections.map((connection) => [connection.id, connection.displayName]));
  const byContent = new Map<string, ContentDeliveryGroup>();
  for (const content of contents) byContent.set(content.id, { content, deliveries: [] });
  for (const delivery of deliveries) {
    const group = byContent.get(delivery.contentId);
    if (!group) continue;
    group.deliveries.push({
      ...delivery,
      connectionName: connectionNames.get(delivery.connectionId) ?? delivery.connectionId,
    });
  }
  return [...byContent.values()].sort((a, b) => b.content.updatedAt - a.content.updatedAt);
}
