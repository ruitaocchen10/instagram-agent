# Socialite

Socialite is a desktop creator studio for preparing, scheduling, and publishing social content. It keeps creator credentials and working content local to the device.

## Language

**Connection**:
A creator-authorized social account or channel on one platform. A connection identifies the destination and its health; it is not the secret credential itself.
_Avoid_: Account, integration

**Credential**:
The secret that authorizes one connection. It lives only in the OS keychain; the non-secret lifecycle beside it records when it expires and whether the platform confirmed that expiry or the app estimated it.
_Avoid_: Token, access token

**Identity**:
The platform's own view of the account behind a connection — handle, name, audience size, avatar.
_Avoid_: Account, profile

**Content**:
The reusable creative intent: base copy, media, and reusable metadata. Content has no platform-specific publishing result or destination.
_Avoid_: Post, campaign

**Delivery**:
One platform-specific publication of content to a connection, including its overrides, schedule, lifecycle, and external result.
_Avoid_: Post, job

**Platform adapter**:
The module that hides one platform's connection, capability, validation, and publication behavior behind the shared content and delivery interface. It is the only place that knows a platform's credential vocabulary, refresh rule, and error shapes.
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

**Published item**:
Something the platform reports as already published for a connection, read back through its adapter. It is the platform's record, not the app's — the app may never have created it and keeps nothing of it locally.
_Avoid_: Published post, feed post
