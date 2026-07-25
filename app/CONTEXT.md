# Socialite

Socialite is a desktop creator studio for preparing, scheduling, and publishing social content. It keeps creator credentials and working content local to the device.

## Language

**Connection**:
A creator-authorized social account or channel on one platform. A connection identifies the destination and its health; it is not the secret credential itself.
_Avoid_: Account, integration

**Content**:
The reusable creative intent: base copy, media, and reusable metadata. Content has no platform-specific publishing result or destination.
_Avoid_: Post, campaign

**Delivery**:
One platform-specific publication of content to a connection, including its overrides, schedule, lifecycle, and external result.
_Avoid_: Post, job

**Platform adapter**:
The module that hides one platform's connection, capability, validation, and publication behavior behind the shared content and delivery interface.
_Avoid_: Client, integration

**Capability**:
A platform adapter's declared support and constraints for a delivery, such as media types, text limits, or posting modes.
_Avoid_: Feature flag

**Publication outcome**:
The definitive result recorded after a platform accepts or rejects a delivery.

**Uncertain outcome**:
A delivery state in which the application cannot determine whether the platform accepted the publication. It is never retried automatically.
_Avoid_: Failed delivery

**Managed media**:
An app-owned local media asset that can be prepared for a delivery without relying on its original external URL.
