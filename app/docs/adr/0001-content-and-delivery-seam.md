# Content and delivery seam

Socialite represents reusable creative as Content and each platform/account publication as an independent Delivery. Platform adapters hide platform-specific behavior behind this seam because a single Instagram-shaped post model would make multi-destination scheduling, failure recovery, and future platform additions unsafe and expensive to change. Legacy Instagram posts will migrate additively and transactionally into one Content plus one Delivery, preserving user intent and retaining a compatibility path until the migration is verified.
