import type { HomeView } from '../../server/src/home-types.js';
import { BADGE_ICON, QUEST_ICON, rankFor } from './cosmic.js';
import { h, prefersReducedMotion, store } from './dom.js';
import { play } from './sound.js';

/**
 * Celebrations compare what the member sees now with what they saw last
 * time, remembered in this browser. XP that arrived while they were away
 * (from the companion, say) is celebrated on the next visit; the first
 * visit just takes a snapshot.
 */

interface Snapshot {
  readonly xp: number;
  readonly level: number;
  readonly quests: readonly string[];
  readonly badges: readonly string[];
}

export interface Changes {
  /** XP gained since the last snapshot, or null on the first visit. */
  readonly xpGained: number | null;
  /** The ring's fill at the last snapshot, so it can animate to the new one. */
  readonly previousFraction: number | null;
  readonly moments: readonly Moment[];
}

type Moment =
  | { kind: 'level'; level: number }
  | { kind: 'quest'; title: string; template: string; xp: number }
  | { kind: 'badge'; id: string; name: string; description: string };

const key = (view: HomeView) => `lifeos.seen.v1:${view.account.displayName}`;

function snapshot(view: HomeView): Snapshot {
  return {
    xp: view.progress.totalXp,
    level: view.progress.level,
    quests: view.quests.filter((q) => q.status === 'complete').map((q) => q.id),
    badges: view.badges.filter((b) => b.earned).map((b) => b.id),
  };
}

/** Works out what changed, and remembers the new state. */
export function takeChanges(view: HomeView): Changes {
  let previous: Snapshot | null = null;
  try {
    previous = JSON.parse(store.get(key(view)) ?? 'null') as Snapshot | null;
  } catch {
    previous = null;
  }
  store.set(key(view), JSON.stringify(snapshot(view)));
  if (!previous || typeof previous.xp !== 'number') return { xpGained: null, previousFraction: null, moments: [] };

  const moments: Moment[] = [];
  if (view.progress.level > previous.level) moments.push({ kind: 'level', level: view.progress.level });
  for (const quest of view.quests) {
    if (quest.status === 'complete' && !previous.quests.includes(quest.id)) {
      moments.push({ kind: 'quest', title: quest.title, template: quest.template, xp: quest.reward.xp });
    }
  }
  for (const badge of view.badges) {
    if (badge.earned && !previous.badges.includes(badge.id)) moments.push({ kind: 'badge', id: badge.id, name: badge.name, description: badge.description });
  }
  const gained = view.progress.totalXp - previous.xp;
  // Animate the ring from its old fill; after a level-up it starts empty.
  const previousFraction = view.progress.level > previous.level ? 0 : Math.max(0, (view.progress.xpIntoLevel - Math.max(0, gained)) / Math.max(1, view.progress.xpForNextLevel));
  return { xpGained: gained, previousFraction, moments };
}

/** "+25 XP" rising from an element. */
export function floatXp(anchor: Element, amount: number): void {
  if (amount <= 0) return;
  const box = anchor.getBoundingClientRect();
  // Rise from the emblem when it's on screen, otherwise from the middle of the view.
  const visible = box.bottom > 40 && box.top < window.innerHeight - 40;
  const left = visible ? box.left + box.width / 2 : window.innerWidth / 2;
  const top = visible ? box.top + box.height / 2 - 20 : window.innerHeight * 0.4;
  const el = h('div', { class: 'float-xp', attrs: { 'aria-hidden': 'true' }, style: { left: `${left}px`, top: `${top}px` } }, `+${amount} XP`);
  document.body.append(el);
  window.setTimeout(() => el.remove(), 1700);
  play.xp();
}

const SPARK_COLORS = ['#ffcf7a', '#a99cff', '#7fdcaa', '#d55181', '#ffffff'];

function sparks(container: HTMLElement): void {
  if (prefersReducedMotion()) return;
  for (let i = 0; i < 28; i++) {
    const angle = (i / 28) * Math.PI * 2 + Math.random() * 0.3;
    const distance = 120 + Math.random() * 120;
    container.append(
      h('span', {
        class: 'spark',
        attrs: { 'aria-hidden': 'true' },
        style: {
          '--dx': `${Math.cos(angle) * distance}px`,
          '--dy': `${Math.sin(angle) * distance}px`,
          '--c': SPARK_COLORS[i % SPARK_COLORS.length]!,
          'animation-delay': `${Math.random() * 120}ms`,
        },
      }),
    );
  }
}

function describe(moment: Moment): { kicker: string; big: string; title: string; text: string; sound: () => void } {
  switch (moment.kind) {
    case 'level': {
      const rank = rankFor(moment.level);
      return { kicker: 'LEVEL UP', big: '🌟', title: `Level ${moment.level}`, text: `You are a ${rank.name}. Real effort, really counted.`, sound: play.level };
    }
    case 'quest':
      return { kicker: 'QUEST COMPLETE', big: QUEST_ICON[moment.template] ?? '🚀', title: moment.title, text: `+${moment.xp} XP quest bonus.`, sound: play.quest };
    case 'badge':
      return { kicker: 'BADGE UNLOCKED', big: BADGE_ICON[moment.id] ?? '🏅', title: moment.name, text: moment.description, sound: play.badge };
  }
}

/** Shows each moment in turn: level-ups first, then quests, then badges. */
export function celebrate(moments: readonly Moment[]): void {
  const order = { level: 0, quest: 1, badge: 2 } as const;
  const queue = [...moments].sort((a, b) => order[a.kind] - order[b.kind]);
  const next = () => {
    const moment = queue.shift();
    if (moment) show(moment, next);
  };
  next();
}

function show(moment: Moment, done: () => void): void {
  const info = describe(moment);
  const returnFocus = document.activeElement as HTMLElement | null;
  const titleId = `celebrate-${Date.now()}`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    returnFocus?.focus?.();
    done();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  const ok = h('button', { class: 'primary', attrs: { type: 'button' } }, 'Onward');
  ok.addEventListener('click', close);
  const panel = h(
    'div',
    { class: 'panel' },
    h('div', { class: 'kicker' }, info.kicker),
    h('div', { class: 'big', attrs: { 'aria-hidden': 'true' } }, info.big),
    h('h2', { id: titleId }, info.title),
    h('p', {}, info.text),
    ok,
  );
  const overlay = h('div', { class: 'celebrate', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } }, panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  sparks(panel);
  info.sound();
  ok.focus();
}
