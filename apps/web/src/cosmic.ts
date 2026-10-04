import type { ProgressView } from '../../server/src/home-types.js';
import { svg } from './dom.js';

// --- ranks: what your level is called --------------------------------------------------

const RANKS: readonly [fromLevel: number, name: string][] = [
  [1, 'Stargazer'],
  [2, 'Spark'],
  [4, 'Wayfinder'],
  [6, 'Navigator'],
  [9, 'Pathfinder'],
  [12, 'Luminary'],
  [16, 'Corona'],
  [21, 'Eclipse'],
];

export function rankFor(level: number): { name: string; next: { name: string; level: number } | null } {
  let index = 0;
  for (let i = 0; i < RANKS.length; i++) if (level >= RANKS[i]![0]) index = i;
  const next = RANKS[index + 1];
  return { name: RANKS[index]![1], next: next ? { name: next[1], level: next[0] } : null };
}

// --- domains -------------------------------------------------------------------------------

export const DOMAIN_COLOR: Record<string, string> = {
  mind: '#9085e9',
  craft: '#199e70',
  world: '#c98500',
  body: '#d55181',
};
const NEUTRAL = '#a99cff';

/** The domain with the most XP colours the emblem's corona; before any XP it's the brand violet. */
export function leadingDomain(progress: ProgressView): string | null {
  let best: { domain: string; xp: number } | null = null;
  for (const domain of progress.domains) {
    const xp = domain.skills.reduce((sum, s) => sum + s.xp, 0);
    if (xp > 0 && (!best || xp > best.xp)) best = { domain: domain.domain, xp };
  }
  return best?.domain ?? null;
}

// --- the eclipse emblem: your avatar ----------------------------------------------------------

let emblemCount = 0;

/**
 * An eclipse that grows with you. The ring is progress to the next level;
 * the corona's rays lengthen with level and take the colour of your strongest
 * domain; a small moon orbits for every skill past level 1.
 */
export function emblem(progress: ProgressView, options: { from?: number; label?: boolean } = {}): SVGSVGElement {
  const id = `e${++emblemCount}`;
  const level = progress.level;
  const lead = leadingDomain(progress);
  const color = lead ? DOMAIN_COLOR[lead]! : NEUTRAL;
  const fraction = progress.xpIntoLevel / Math.max(1, progress.xpForNextLevel);
  const rays = Math.min(36, 10 + level * 2);
  const rayLength = Math.min(30, 8 + level * 2);
  const ringR = 86;
  const circumference = 2 * Math.PI * ringR;
  const grown = progress.domains.flatMap((d) => d.skills.map((s) => ({ ...s, domain: d.domain }))).filter((s) => s.level >= 2).slice(0, 10);

  const progressCircle = svg('circle', {
    class: 'ring-progress',
    cx: 100,
    cy: 100,
    r: ringR,
    fill: 'none',
    stroke: `url(#${id}-ring)`,
    'stroke-width': 7,
    'stroke-linecap': 'round',
    'stroke-dasharray': circumference,
    'stroke-dashoffset': circumference * (1 - (options.from ?? fraction)),
    transform: 'rotate(-90 100 100)',
  });
  if (options.from !== undefined && options.from !== fraction) {
    // Fill the ring from where it was to where it is now.
    requestAnimationFrame(() => requestAnimationFrame(() => progressCircle.setAttribute('stroke-dashoffset', String(circumference * (1 - fraction)))));
  }

  const el = svg(
    'svg',
    { class: 'emblem', viewBox: '0 0 200 200', role: 'img', 'aria-label': `Level ${level}, ${rankFor(level).name}. ${progress.xpIntoLevel} of ${progress.xpForNextLevel} XP to the next level.` },
    svg(
      'defs',
      {},
      svg('radialGradient', { id: `${id}-corona` }, svg('stop', { offset: '55%', 'stop-color': color, 'stop-opacity': 0.95 }), svg('stop', { offset: '72%', 'stop-color': color, 'stop-opacity': 0.35 }), svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 })),
      svg('linearGradient', { id: `${id}-ring`, x1: 0, y1: 0, x2: 1, y2: 1 }, svg('stop', { offset: '0%', 'stop-color': '#7b6cff' }), svg('stop', { offset: '60%', 'stop-color': '#a99cff' }), svg('stop', { offset: '100%', 'stop-color': '#ffcf7a' })),
      svg('filter', { id: `${id}-glow`, x: '-50%', y: '-50%', width: '200%', height: '200%' }, svg('feGaussianBlur', { stdDeviation: 3 })),
    ),
    svg('circle', { class: 'halo', cx: 100, cy: 100, r: 64 + Math.min(16, level * 1.5), fill: `url(#${id}-corona)`, opacity: Math.min(1, 0.6 + level * 0.04) }),
    svg(
      'g',
      { class: 'rays', stroke: color, 'stroke-linecap': 'round', opacity: 0.75 },
      ...Array.from({ length: rays }, (_, i) => {
        const angle = (i / rays) * Math.PI * 2;
        const long = i % 2 === 0 ? rayLength : rayLength * 0.6;
        const [x1, y1] = [100 + Math.cos(angle) * 50, 100 + Math.sin(angle) * 50];
        const [x2, y2] = [100 + Math.cos(angle) * (50 + long), 100 + Math.sin(angle) * (50 + long)];
        return svg('line', { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1), 'stroke-width': i % 2 === 0 ? 2 : 1.2 });
      }),
    ),
    svg('circle', { cx: 100, cy: 100, r: ringR, fill: 'none', stroke: '#262c57', 'stroke-width': 7 }),
    progressCircle,
    svg(
      'g',
      { class: 'orbit' },
      ...grown.map((s, i) => {
        const angle = (i / Math.max(1, grown.length)) * Math.PI * 2;
        return svg('circle', { cx: (100 + Math.cos(angle) * 70).toFixed(1), cy: (100 + Math.sin(angle) * 70).toFixed(1), r: 3.5, fill: DOMAIN_COLOR[s.domain] ?? NEUTRAL });
      }),
    ),
    svg('circle', { cx: 100, cy: 100, r: 48, fill: '#070a1c', stroke: 'rgb(255 255 255 / 0.14)', 'stroke-width': 1 }),
    options.label === false ? null : svg('text', { class: 'lvl-label', x: 100, y: 84, 'text-anchor': 'middle' }, 'LEVEL'),
    options.label === false ? null : svg('text', { class: 'lvl', x: 100, y: 120, 'text-anchor': 'middle' }, level),
  );
  return el;
}

/** The small eclipse in the header. */
export function miniEclipse(): SVGSVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 32 32', 'aria-hidden': 'true' },
    svg('circle', { cx: 16, cy: 16, r: 13, fill: 'none', stroke: '#ffcf7a', 'stroke-width': 2, opacity: 0.9 }),
    svg('circle', { cx: 16, cy: 16, r: 15, fill: 'none', stroke: '#a99cff', 'stroke-width': 1, opacity: 0.5 }),
    svg('circle', { cx: 17.5, cy: 15, r: 11, fill: '#070a1c' }),
  );
}

// --- the skill constellation -------------------------------------------------------------

/** Star positions inside each domain's quarter of the sky (170 × 150). */
const STAR_POSITIONS: Record<string, readonly [number, number][]> = {
  mind: [[42, 72], [92, 46], [134, 98]],
  craft: [[36, 100], [84, 54], [138, 82]],
  body: [[34, 62], [76, 104], [122, 58], [148, 112]],
  world: [[42, 70], [96, 108], [140, 52]],
};
/** Mind and craft on top, body and world below: neighbours were validated as colour pairs. */
const QUADRANT: Record<string, [number, number]> = { mind: [0, 0], craft: [170, 0], body: [0, 150], world: [170, 150] };

export interface TipHandlers {
  show(event: MouseEvent | FocusEvent, text: string): void;
  hide(): void;
}

export function constellation(progress: ProgressView, tips: TipHandlers): SVGSVGElement {
  const groups = progress.domains.map((domain) => {
    const [ox, oy] = QUADRANT[domain.domain] ?? [0, 0];
    const color = DOMAIN_COLOR[domain.domain] ?? NEUTRAL;
    const positions = STAR_POSITIONS[domain.domain] ?? [];
    const stars = domain.skills.map((skill, i) => ({ skill, x: ox + (positions[i]?.[0] ?? 30 + i * 40), y: oy + (positions[i]?.[1] ?? 80) }));
    const lit = (s: (typeof stars)[number]) => s.skill.xp > 0;

    const lines = stars.slice(1).map((star, i) => {
      const prev = stars[i]!;
      const both = lit(prev) && lit(star);
      return svg('line', {
        x1: prev.x,
        y1: prev.y,
        x2: star.x,
        y2: star.y,
        stroke: both ? color : '#9aa0cc',
        'stroke-opacity': both ? 0.7 : 0.25,
        'stroke-width': both ? 1.5 : 1,
        'stroke-dasharray': both ? '' : '2 4',
      });
    });

    const starEls = stars.map(({ skill, x, y }) => {
      const name = skill.skill.charAt(0).toUpperCase() + skill.skill.slice(1);
      const on = skill.xp > 0;
      const r = on ? 4.5 + Math.min(10, skill.level) * 1.1 : 3;
      const label = `${name}: level ${skill.level}, ${skill.xp} XP${on ? '' : ' (not lit yet)'}`;
      const g = svg(
        'g',
        { class: 'star', tabindex: 0, role: 'img', 'aria-label': label },
        // An invisible hit area bigger than the star.
        svg('circle', { cx: x, cy: y, r: 16, fill: 'transparent' }),
        on ? svg('circle', { class: 'twinkle', cx: x, cy: y, r: r * 2.6, fill: color, opacity: Math.min(0.45, 0.18 + skill.level * 0.04) }) : null,
        svg('circle', on
          ? { class: 'star-core', cx: x, cy: y, r, fill: color, stroke: '#fff', 'stroke-opacity': 0.6, 'stroke-width': 1 }
          : { class: 'star-core', cx: x, cy: y, r, fill: 'none', stroke: '#9aa0cc', 'stroke-opacity': 0.7, 'stroke-width': 1 }),
        svg('text', { class: 'star-label', x, y: y + r * (on ? 2.2 : 1) + 11, 'text-anchor': 'middle' }, on ? `${name} · ${skill.level}` : name),
      );
      g.addEventListener('mouseenter', (e) => tips.show(e, label));
      g.addEventListener('focus', (e) => tips.show(e, label));
      g.addEventListener('mouseleave', tips.hide);
      g.addEventListener('blur', tips.hide);
      return g;
    });

    return svg(
      'g',
      {},
      svg('circle', { cx: ox + 14, cy: oy + 18, r: 4, fill: color }),
      svg('text', { class: 'domain-label', x: ox + 24, y: oy + 21.5, fill: '#c2c6e8' }, domain.domain.toUpperCase()),
      ...lines,
      ...starEls,
    );
  });
  return svg(
    'svg',
    { class: 'sky', viewBox: '0 0 340 300', role: 'group', 'aria-label': 'Skill constellation. Each star is a skill; it lights up when you earn XP in it and grows with its level.' },
    svg('line', { x1: 170, y1: 10, x2: 170, y2: 290, stroke: '#2a3060', 'stroke-dasharray': '1 6' }),
    svg('line', { x1: 10, y1: 150, x2: 330, y2: 150, stroke: '#2a3060', 'stroke-dasharray': '1 6' }),
    ...groups,
  );
}

// --- badges ----------------------------------------------------------------------------------

export const BADGE_ICON: Record<string, string> = {
  'first-light': '🌅',
  'deep-focus': '🎯',
  'in-motion': '🏃',
  'open-sky': '🌲',
  'mission-control': '🚀',
  'clear-intent': '✅',
  'true-north': '🧭',
  'long-haul': '⏳',
  'full-orbit': '🪐',
  constellation: '✨',
  'rising-star': '🌟',
  'founding-crew': '🛸',
};

export const QUEST_ICON: Record<string, string> = {
  'daily-focus': '🎯',
  'weekly-movement': '🏃',
  'weekly-recovery': '🌿',
};
