// Mock data for the MVP UI. Photos come from picsum (seeded so they're stable);
// they resolve when online and simply show the neutral placeholder box offline.

import type { Account, AiProvider, ChatMessage, Post } from "../shared/types";

export const img = (seed: string, size = 600) =>
  `https://picsum.photos/seed/${seed}/${size}/${size}`;

export const MOCK_ACCOUNT: Account = {
  username: "findurfootingapp",
  fullName: "Find Ur Footing",
  followers: 4820,
  igUserId: "17841400000000000",
};

export const MOCK_PROVIDERS: AiProvider[] = [
  { id: "claude", name: "Claude", model: "sonnet · via Claude Code", connected: true },
  { id: "openai", name: "OpenAI", model: "gpt-4o", connected: false },
];

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();

// Instagram-owned published posts. Stand-in for the Graph API feed until the
// remote-data pass wires in real fetching — these are NOT persisted locally.
export const MOCK_PUBLISHED: Post[] = [
  {
    id: "pub1",
    imageUrl: img("river-crossing"),
    caption: "River crossings 101 — tag someone who needs this 💧",
    status: "published",
    publishedAt: now - 2 * DAY,
    likes: 612,
    comments: 34,
  },
  {
    id: "pub2",
    imageUrl: img("tent-night"),
    caption: "Cowboy camping under a full moon. 10/10 would freeze again.",
    status: "published",
    publishedAt: now - 5 * DAY,
    likes: 908,
    comments: 51,
  },
  {
    id: "pub3",
    imageUrl: img("desert-dawn"),
    caption: "Desert dawn patrol. Worth every 4am alarm.",
    status: "published",
    publishedAt: now - 9 * DAY,
    likes: 1204,
    comments: 88,
  },
];

// App-owned seed posts written to SQLite on first run so the app isn't empty.
// After that, the local DB is the source of truth for drafts + scheduled posts.
export const SEED_POSTS: Post[] = [
  {
    id: "p1",
    imageUrl: img("trail-sunrise"),
    caption:
      "Sunrise miles hit different 🌄 New trail guide is live — link in bio. #trailrunning #getoutside",
    status: "scheduled",
    scheduledAt: now + 6 * HOUR,
    updatedAt: now - 1 * HOUR,
  },
  {
    id: "p2",
    imageUrl: img("hiking-boots"),
    caption: "Break in your boots before they break you. 3 tips we swear by 👇",
    status: "scheduled",
    scheduledAt: now + 1 * DAY + 3 * HOUR,
    updatedAt: now - 2 * HOUR,
  },
  {
    id: "p3",
    imageUrl: img("mountain-lake"),
    caption: "Weekend plans, sorted. Where are you heading? 🏔️",
    status: "scheduled",
    scheduledAt: now + 3 * DAY + 5 * HOUR,
    updatedAt: now - 3 * HOUR,
  },
  {
    id: "p4",
    imageUrl: img("campfire"),
    caption: "Golden hour + good company. That's the whole post. ✨",
    status: "scheduled",
    scheduledAt: now + 5 * DAY + 2 * HOUR,
    updatedAt: now - 4 * HOUR,
  },
  {
    id: "d1",
    imageUrl: img("gear-flatlay"),
    caption: "The 5 things always in our pack. Save this for your next trip 🎒",
    status: "draft",
    updatedAt: now - 5 * HOUR,
  },
  {
    id: "d2",
    imageUrl: img("forest-path"),
    caption: "",
    status: "draft",
    updatedAt: now - 6 * HOUR,
  },
  {
    id: "d3",
    imageUrl: img("summit-view"),
    caption: "POV: you finally reached the top and forgot every complaint on the way up.",
    status: "draft",
    updatedAt: now - 7 * HOUR,
  },
];

export const SUGGESTED_PROMPTS = [
  "Plan a week of posts about trail running",
  "Write 3 caption options for this sunrise photo",
  "What should I post to grow engagement?",
  "Turn my last blog post into a carousel",
];

// Canned assistant reply used when the user sends a message in the mock.
export function mockAiReply(): ChatMessage {
  return {
    id: `m${Date.now()}`,
    role: "ai",
    text: "Love it. Here are three post ideas built around that theme — each has a caption ready to go. Hit “Send to composer” on any you like and I'll drop it into the editor so you can publish or schedule it.",
    ideas: [
      {
        id: `i${Date.now()}-1`,
        title: "Sunrise motivation",
        caption:
          "The trail doesn't care what time you woke up — but your future self does. 🌅 Save this for your next early start. #trailrunning",
        imageUrl: img(`idea-${Date.now()}-a`, 300),
      },
      {
        id: `i${Date.now()}-2`,
        title: "Gear checklist carousel",
        caption: "5 things always in our pack 🎒 Swipe for the full list and tag your hiking buddy.",
        imageUrl: img(`idea-${Date.now()}-b`, 300),
      },
      {
        id: `i${Date.now()}-3`,
        title: "Community question",
        caption: "Where's the best trail you've run this month? Drop it below 👇 we're building a summer list.",
        imageUrl: img(`idea-${Date.now()}-c`, 300),
      },
    ],
  };
}
