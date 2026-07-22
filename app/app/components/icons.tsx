// Thin wrappers around lucide-react icons, keeping the existing
// Icon* names/props (size, className) so call sites didn't need to change.
import {
  Home,
  MessageSquare,
  SquarePen,
  Calendar,
  LayoutGrid,
  Settings,
  Send,
  Sparkles,
  Clock,
  Zap,
  Heart,
  MessageCircle,
  Share2,
  Bookmark,
  MoreHorizontal,
  MoreVertical,
  Search,
  ChevronLeft,
  ChevronRight,
  Plus,
  Image as ImageIcon,
  Check,
  Moon,
  Sun,
  Users,
  Trash2,
  ArrowUp,
  ArrowDown,
  Folder,
  PenLine,
} from "lucide-react";

type P = { size?: number; className?: string };

const STROKE_WIDTH = 1.6;

export const IconHome = ({ size, className }: P) => (
  <Home size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconChat = ({ size, className }: P) => (
  <MessageSquare size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconCompose = ({ size, className }: P) => (
  <SquarePen size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconCalendar = ({ size, className }: P) => (
  <Calendar size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconLibrary = ({ size, className }: P) => (
  <LayoutGrid size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconSettings = ({ size, className }: P) => (
  <Settings size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconSend = ({ size, className }: P) => (
  <Send size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconSparkle = ({ size, className }: P) => (
  <Sparkles size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconClock = ({ size, className }: P) => (
  <Clock size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconBolt = ({ size, className }: P) => (
  <Zap size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconHeart = ({ size, className }: P) => (
  <Heart size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconComment = ({ size, className }: P) => (
  <MessageCircle size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconShare = ({ size, className }: P) => (
  <Share2 size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconBookmark = ({ size, className }: P) => (
  <Bookmark size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconMore = ({ size, className }: P) => (
  <MoreHorizontal size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconChevronLeft = ({ size, className }: P) => (
  <ChevronLeft size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconChevronRight = ({ size, className }: P) => (
  <ChevronRight size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconPlus = ({ size, className }: P) => (
  <Plus size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconImage = ({ size, className }: P) => (
  <ImageIcon size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconCheck = ({ size, className }: P) => (
  <Check size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconMoon = ({ size, className }: P) => (
  <Moon size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconSun = ({ size, className }: P) => (
  <Sun size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconUsers = ({ size, className }: P) => (
  <Users size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconTrash = ({ size, className }: P) => (
  <Trash2 size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconTrendUp = ({ size, className }: P) => (
  <ArrowUp size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconTrendDown = ({ size, className }: P) => (
  <ArrowDown size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconFolder = ({ size, className }: P) => (
  <Folder size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconSearch = ({ size, className }: P) => (
  <Search size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconMoreVertical = ({ size, className }: P) => (
  <MoreVertical size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

export const IconPen = ({ size, className }: P) => (
  <PenLine size={size} className={className} strokeWidth={STROKE_WIDTH} />
);

// Lucide ships generic shapes only, not brand marks — keep a hand-rolled
// glyph so the Instagram logo still reads correctly at small sizes.
export const IconInstagram = ({ size = 20, className }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={STROKE_WIDTH}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17" cy="7" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);
