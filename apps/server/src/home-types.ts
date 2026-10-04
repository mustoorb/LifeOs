/**
 * Response shapes of the ECLIPSE home API. Types only, so the web client can
 * import them without pulling in server code.
 */

export interface Window {
  readonly start: number;
  readonly end: number;
}

export interface SkillProgress {
  readonly skill: string;
  readonly xp: number;
  readonly level: number;
  readonly xpIntoLevel: number;
  readonly xpForNextLevel: number;
}

export interface ProgressView {
  readonly totalXp: number;
  /** XP waiting on review or confirmation; not counted yet. */
  readonly heldXp: number;
  readonly level: number;
  readonly xpIntoLevel: number;
  readonly xpForNextLevel: number;
  readonly domains: readonly { readonly domain: string; readonly skills: readonly SkillProgress[] }[];
}

export interface CriterionView {
  readonly unit: string;
  readonly current: number;
  readonly required: number;
}

export interface QuestView {
  readonly id: string;
  readonly template: string;
  readonly kind: string;
  readonly title: string;
  readonly intent: string;
  readonly window: Window;
  readonly status: 'active' | 'complete' | 'skipped' | 'ended';
  readonly progress: number;
  readonly criteria: readonly CriterionView[];
  readonly reward: { readonly xp: number; readonly skill: string };
  /** Completed with self-reported evidence only. */
  readonly provisional: boolean;
  readonly minEvidence: string;
}

export interface ActivityView {
  readonly id: string;
  readonly type: string;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly minutes: number;
  readonly evidenceLevel: string;
  readonly sources: readonly string[];
  readonly userConfirmation: string;
  readonly needsReview: boolean;
  readonly reviewReasons: readonly string[];
  readonly award: {
    readonly xp: number;
    readonly status: string;
    readonly explanation: readonly string[];
    readonly skills: readonly { readonly skill: string; readonly xp: number }[];
  } | null;
  readonly eligibleSkills: readonly string[];
}

export interface PriorityView {
  readonly id: string;
  readonly text: string;
  readonly skill: string | null;
  readonly done: boolean;
}

export interface HomeView {
  readonly account: { readonly displayName: string; readonly timeZone: string };
  readonly today: { readonly dateKey: string; readonly window: Window };
  readonly progress: ProgressView;
  readonly priorities: readonly PriorityView[];
  readonly quests: readonly QuestView[];
  readonly activities: readonly ActivityView[];
  readonly review: readonly ActivityView[];
  readonly recentAwards: readonly {
    readonly id: string;
    readonly at: number;
    readonly kind: string;
    readonly xp: number;
    readonly status: string;
    readonly explanation: readonly string[];
    readonly reversalReason: string | null;
  }[];
  readonly season: { readonly id: string; readonly name: string; readonly endsAt: number; readonly leaderboardOptIn: boolean } | null;
}

export interface RecapView {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly window: Window;
  readonly totals: { readonly minutes: number; readonly sessions: number; readonly xp: number };
  readonly previousWeekMinutes: number;
  readonly days: readonly { readonly dateKey: string; readonly minutes: number }[];
  readonly domains: readonly { readonly domain: string; readonly minutes: number; readonly xp: number }[];
  readonly quests: {
    readonly completed: number;
    readonly offered: number;
    readonly items: readonly { readonly title: string; readonly status: 'complete' | 'skipped' | 'open' }[];
  };
  readonly priorities: { readonly planned: number; readonly done: number };
  readonly corrections: number;
  readonly notes: readonly string[];
  /** The member's answer to "did this represent your week?". */
  readonly feedback: boolean | null;
}
