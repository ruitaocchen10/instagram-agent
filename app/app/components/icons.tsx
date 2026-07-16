// Lightweight inline SVG icons (stroke-based, 1.6px, currentColor).
// Keeps the bundle offline-friendly and the icon language consistent.

type P = { size?: number; className?: string };

const base = (size = 20) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconHome = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </svg>
);

export const IconChat = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 5h16v11H8l-4 4z" />
    <path d="M8 9.5h8M8 12.5h5" />
  </svg>
);

export const IconCompose = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 20h16" />
    <path d="M14.5 4.5 19 9 8.5 19.5 4 21l1.5-4.5z" />
  </svg>
);

export const IconCalendar = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
    <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
  </svg>
);

export const IconLibrary = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconSettings = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19" />
  </svg>
);

export const IconSend = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 12 20 4l-6 16-3-7-7-1z" />
  </svg>
);

export const IconSparkle = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  </svg>
);

export const IconClock = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconBolt = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M13 3 5 13h5l-1 8 8-11h-5z" />
  </svg>
);

export const IconHeart = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 20s-7-4.4-9.2-8.4C1.2 8.3 3 5 6.2 5 8.3 5 9.6 6.3 12 8.8 14.4 6.3 15.7 5 17.8 5 21 5 22.8 8.3 21.2 11.6 19 15.6 12 20 12 20z" />
  </svg>
);

export const IconComment = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M20 12a7.5 7.5 0 0 1-10.6 6.8L4 20l1.2-5.4A7.5 7.5 0 1 1 20 12z" />
  </svg>
);

export const IconShare = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 12 21 4l-6 16-3.5-6.5z" />
  </svg>
);

export const IconBookmark = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M6 4h12v17l-6-4-6 4z" />
  </svg>
);

export const IconMore = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);

export const IconChevronLeft = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const IconChevronRight = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);

export const IconPlus = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconImage = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="M4 17l5-4 4 3 3-2 4 3" />
  </svg>
);

export const IconCheck = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12.5 10 17 19 7" />
  </svg>
);

export const IconMoon = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
  </svg>
);

export const IconSun = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" />
  </svg>
);

export const IconInstagram = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17" cy="7" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconUsers = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9" />
  </svg>
);

export const IconTrash = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13" />
  </svg>
);
