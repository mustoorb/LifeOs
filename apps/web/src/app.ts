import type { ActivityView, BadgeView, HomeView, ProgressView, QuestView, RecapView } from '../../server/src/home-types.js';
import { ApiError, api, type Correction } from './api.js';
import { celebrate, floatXp, takeChanges } from './celebrate.js';
import { BADGE_ICON, QUEST_ICON, constellation, emblem, miniEclipse, rankFor } from './cosmic.js';
import { h, store } from './dom.js';
import { play, setSound, soundOn } from './sound.js';

const header = document.getElementById('header')!;
const main = document.getElementById('main')!;
const toastEl = document.getElementById('toast')!;
const tooltip = document.getElementById('tooltip')!;

let toastTimer = 0;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4500);
}

/** Runs an action, reporting failures; a 401 sends the member to sign in. */
async function run(task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showSignIn();
      return;
    }
    toast(error instanceof Error ? error.message : String(error));
  }
}

function button(label: string, action: () => Promise<unknown>, kind = ''): HTMLButtonElement {
  const el = h('button', { class: kind, attrs: { type: 'button' } }, label);
  el.addEventListener('click', () => {
    el.disabled = true;
    void run(action).finally(() => (el.disabled = false));
  });
  return el;
}

// --- formatting ----------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  digital_session: 'Focused work',
  learning_session: 'Learning',
  creative_session: 'Creating',
  workout: 'Workout',
  walk: 'Walk',
  run: 'Run',
  ride: 'Ride',
  outdoor_session: 'Outdoors',
  manual_log: 'Logged activity',
  other: 'Other',
};
const EVIDENCE_LABELS: Record<string, string> = {
  self_reported: 'Self-reported',
  observed: 'Observed',
  connected: 'Connected',
  corroborated: 'Corroborated',
  reviewed: 'Reviewed',
};
const MANUAL_TYPES = ['workout', 'walk', 'run', 'ride', 'outdoor_session', 'learning_session', 'creative_session'];
const CORRECTABLE_TYPES = ['digital_session', 'learning_session', 'creative_session', ...MANUAL_TYPES.slice(0, 5)];

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/[-_]/g, ' ');
const typeLabel = (type: string) => TYPE_LABELS[type] ?? cap(type);

function duration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, '0')}m`;
}

function clock(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
}

function dayLabel(dateKey: string, style: 'short' | 'long' = 'short'): string {
  const noon = Date.parse(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat(undefined, style === 'short' ? { timeZone: 'UTC', weekday: 'short' } : { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(noon);
}

function meter(fraction: number, label: string): HTMLElement {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return h(
    'div',
    { class: 'meter', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': label } },
    h('span', { style: { width: `${pct}%` } }),
  );
}

function select(options: readonly [value: string, label: string][], selected?: string, aria?: string): HTMLSelectElement {
  const el = h('select', aria ? { attrs: { 'aria-label': aria } } : {});
  for (const [value, label] of options) {
    const option = h('option', { attrs: { value } }, label);
    if (value === selected) option.selected = true;
    el.append(option);
  }
  return el;
}

// --- routing ---------------------------------------------------------------------------

type Route = { view: 'today' } | { view: 'week'; week?: string } | { view: 'badges' };

function route(): Route {
  if (location.hash === '#/badges') return { view: 'badges' };
  const match = /^#\/week(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(location.hash);
  return match ? { view: 'week', ...(match[1] ? { week: match[1] } : {}) } : { view: 'today' };
}

let account: HomeView['account'] | null = null;

function soundToggle(): HTMLButtonElement {
  const el = h('button', { class: 'quiet', attrs: { type: 'button' } });
  const paint = () => {
    const on = soundOn();
    el.textContent = on ? '🔊 Sound' : '🔇 Sound';
    el.setAttribute('aria-pressed', String(on));
    el.title = on ? 'Turn sound effects off' : 'Turn sound effects on';
  };
  el.addEventListener('click', () => {
    setSound(!soundOn());
    paint();
    play.tick();
  });
  paint();
  return el;
}

function renderHeader(signedIn: boolean): void {
  const current = route().view;
  const link = (href: string, label: string, view: Route['view']) => h('a', { attrs: { href, ...(current === view ? { 'aria-current': 'page' } : {}) } }, label);
  const parts: (Node | null)[] = [
    h('span', { class: 'brand' }, miniEclipse(), h('span', {}, 'ECLIPSE')),
    signedIn ? h('nav', { class: 'nav', attrs: { 'aria-label': 'Main' } }, link('#/', 'Today', 'today'), link('#/week', 'Week', 'week'), link('#/badges', 'Badges', 'badges')) : null,
    h('span', { class: 'spacer' }),
    signedIn ? soundToggle() : null,
    signedIn && account ? h('span', { class: 'who' }, account.displayName) : null,
    signedIn
      ? button('Sign out', async () => {
          await api.logout();
          account = null;
          showSignIn();
        }, 'quiet')
      : null,
  ];
  header.replaceChildren(...parts.filter((part): part is Node => part !== null));
}

async function render(): Promise<void> {
  const current = route();
  if (current.view === 'week') await showWeek(current.week);
  else if (current.view === 'badges') await showBadges();
  else await showToday();
}

window.addEventListener('hashchange', () => void run(render));

// --- sign-in -----------------------------------------------------------------------------

/** The emblem on the sign-in screens: a fresh level-1 eclipse, a third of the way round. */
const WELCOME: ProgressView = { totalXp: 0, heldXp: 0, level: 1, xpIntoLevel: 33, xpForNextLevel: 100, domains: [] };

function authCard(title: string, intro: Node | string, ...rest: Node[]): HTMLElement {
  const art = emblem(WELCOME, { label: false });
  art.setAttribute('aria-hidden', 'true');
  return h('section', { class: 'card auth' }, art, h('h1', {}, title), h('p', { class: 'muted' }, intro), ...rest);
}

function showSignIn(): void {
  account = null;
  renderHeader(false);
  const email = h('input', { attrs: { type: 'email', autocomplete: 'email', placeholder: 'you@example.com', 'aria-label': 'Email', required: '' } });
  const form = h('form', { class: 'stackform' }, email, h('button', { class: 'primary', attrs: { type: 'submit' } }, 'Email me a sign-in code'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      await api.startSignIn(email.value);
      showCode(email.value.trim());
    });
  });
  main.replaceChildren(authCard('Welcome to LifeOS', 'Your real effort, made playable. Sign in with your email; we will send you a six-digit code.', form));
  email.focus();
}

function showCode(email: string): void {
  const code = h('input', { attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456', 'aria-label': 'Sign-in code', required: '' } });
  const form = h('form', { class: 'stackform' }, code, h('button', { class: 'primary', attrs: { type: 'submit' } }, 'Continue'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const result = await api.verify(email, code.value.replace(/\s/g, ''));
      if (result.status === 'signed_in') await render();
      else showRegister(result.registrationToken, result.termsVersion, email);
    });
  });
  main.replaceChildren(
    authCard('Check your email', h('span', {}, 'Enter the code we sent to ', h('strong', {}, email), '. It expires in 10 minutes.'), form, h('p', {}, button('Use a different email', async () => showSignIn(), 'link'))),
  );
  code.focus();
}

function showRegister(registrationToken: string, termsVersion: string, email: string): void {
  const field = (label: string, input: HTMLElement, hint?: string) => h('label', {}, label, input, hint ? h('span', { class: 'small muted' }, hint) : null);
  const accessCode = h('input', { attrs: { autocomplete: 'off', placeholder: 'ABCD-1234', required: '' } });
  const name = h('input', { attrs: { maxlength: '40', autocomplete: 'nickname', required: '' } });
  const birthDate = h('input', { attrs: { type: 'date', required: '' } });
  const region = h('input', { attrs: { maxlength: '2', placeholder: 'FR', autocomplete: 'country', required: '' } });
  const terms = h('input', { attrs: { type: 'checkbox', required: '' } });
  const form = h(
    'form',
    { class: 'stackform' },
    field('Access code', accessCode),
    field('Name others will see', name),
    field('Date of birth', birthDate, 'Only used to confirm you are 18 or older. It is not stored.'),
    field('Country (two letters)', region),
    h('label', { class: 'row small' }, terms, `I am 18 or older and accept the LifeOS terms (${termsVersion}).`),
    h('button', { class: 'primary', attrs: { type: 'submit' } }, 'Create account'),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      await api.register({
        registrationToken,
        accessCode: accessCode.value.trim(),
        displayName: name.value.trim(),
        birthDate: birthDate.value,
        region: region.value.trim(),
        acceptedTerms: termsVersion,
      });
      await render();
    });
  });
  main.replaceChildren(authCard('Join LifeOS', h('span', {}, 'No account uses ', h('strong', {}, email), ' yet. LifeOS is invite-only for now: use your access code.'), form));
  accessCode.focus();
}

// --- today ---------------------------------------------------------------------------------

async function showToday(): Promise<void> {
  const view = await api.home();
  account = view.account;
  renderHeader(true);
  const refresh = () => run(showToday);
  const changes = takeChanges(view);
  const hero = heroCard(view, changes.previousFraction);
  main.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      hero,
      h(
        'div',
        { class: 'grid' },
        h('div', { class: 'stack' }, prioritiesCard(view, refresh), questsCard(view, refresh), reviewCard(view, refresh), activityCard(view, refresh), logCard(refresh)),
        h('div', { class: 'stack' }, skillsCard(view), badgesCard(view.badges), awardsCard(view)),
      ),
    ),
  );
  if (changes.xpGained && changes.xpGained > 0) floatXp(hero.querySelector('.emblem') ?? hero, changes.xpGained);
  if (changes.moments.length) window.setTimeout(() => celebrate(changes.moments), changes.xpGained ? 900 : 200);
}

function heroCard(view: HomeView, from: number | null): HTMLElement {
  const p = view.progress;
  const rank = rankFor(p.level);
  const todayMinutes = view.activities.filter((a) => a.userConfirmation !== 'discarded').reduce((sum, a) => sum + a.minutes, 0);
  const questsDone = view.quests.filter((q) => q.status === 'complete').length;
  const earned = view.badges.filter((b) => b.earned).length;
  const daysLeft = view.season ? Math.max(0, Math.ceil((view.season.endsAt - Date.now()) / 86_400_000)) : null;
  const stat = (label: string, value: string) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
  return h(
    'section',
    { class: 'card hero', attrs: { 'data-testid': 'level' } },
    emblem(p, from === null ? {} : { from }),
    h(
      'div',
      { class: 'hero-info' },
      h('h1', {}, view.account.displayName),
      h('div', { class: 'rank' }, `✦ ${rank.name}`, rank.next ? h('span', { class: 'next-rank' }, `· ${rank.next.name} at level ${rank.next.level}`) : null),
      h('div', { class: 'row between small' }, h('span', { class: 'muted' }, `${p.xpIntoLevel} / ${p.xpForNextLevel} XP to level ${p.level + 1}`), h('span', { class: 'xp' }, `${p.totalXp} XP`)),
      meter(p.xpIntoLevel / Math.max(1, p.xpForNextLevel), 'Progress to next level'),
      p.heldXp > 0 ? h('p', { class: 'small warn' }, `${p.heldXp} XP is waiting on your review below.`) : null,
      view.season ? h('p', { class: 'small muted', style: { margin: '4px 0 0' } }, `🛰 ${view.season.name} · ${daysLeft === 1 ? '1 day' : `${daysLeft} days`} left`) : null,
      h('div', { class: 'stats' }, stat('Today', duration(todayMinutes)), stat('Quests done', `${questsDone} / ${view.quests.length}`), stat('Badges', `${earned} / ${view.badges.length}`)),
    ),
  );
}

function prioritiesCard(view: HomeView, refresh: () => Promise<void>): HTMLElement {
  const items = view.priorities.map((p) => {
    const box = h('input', { class: 'planet', attrs: { type: 'checkbox', 'aria-label': `Done: ${p.text}` } });
    box.checked = p.done;
    box.addEventListener('change', () => void run(async () => {
      if (box.checked) play.tick();
      await api.setPriority(p.id, box.checked);
      await refresh();
    }));
    return h(
      'li',
      {},
      box,
      h('span', { class: `grow${p.done ? ' done-text' : ''}` }, p.text),
      p.skill ? h('span', { class: 'pill' }, cap(p.skill)) : null,
      button('Remove', async () => {
        await api.deletePriority(p.id);
        await refresh();
      }, 'quiet'),
    );
  });
  let form: HTMLElement | null = null;
  if (view.priorities.length < 3) {
    const text = h('input', { class: 'grow', attrs: { maxlength: '120', placeholder: 'What matters today?', 'aria-label': 'New priority' } });
    const skills = view.progress.domains.flatMap((d) => d.skills.map((s) => [s.skill, cap(s.skill)] as [string, string]));
    const skill = select([['', 'No skill'], ...skills], '', 'Skill');
    form = h('form', { class: 'row priority-form', style: { 'margin-top': '10px' } }, text, skill, h('button', { attrs: { type: 'submit' } }, 'Add'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!text.value.trim()) return;
      void run(async () => {
        await api.addPriority(text.value.trim(), skill.value || null);
        await refresh();
      });
    });
  }
  const done = view.priorities.filter((p) => p.done).length;
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'priorities' } },
    h('div', { class: 'row between' }, h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '🪐'), dayLabel(view.today.dateKey, 'long')), view.priorities.length ? h('span', { class: `pill${done === view.priorities.length ? ' good' : ''}` }, `${done} / ${view.priorities.length} done`) : null),
    h('p', { class: 'sub' }, 'Today’s orbit: up to three priorities. Fewer is fine.'),
    items.length ? h('ul', { class: 'list' }, ...items) : null,
    form,
  );
}

function questCard(quest: QuestView, refresh: () => Promise<void>): HTMLElement {
  const status: Record<QuestView['status'], [string, string]> = {
    active: ['In progress', ''],
    complete: [quest.provisional ? '✓ Complete · self-reported' : '✓ Complete', 'good'],
    skipped: ['Skipped', ''],
    ended: ['Ended', ''],
  };
  const [label, tone] = status[quest.status];
  return h(
    'div',
    { class: `mission${quest.status === 'complete' ? ' done' : ''}`, attrs: { 'data-quest': quest.template } },
    h('div', { class: 'row between' }, h('span', { class: 'title' }, h('span', { class: 'badge-icon', attrs: { 'aria-hidden': 'true' } }, QUEST_ICON[quest.template] ?? '🚀'), quest.title), h('span', { class: `pill ${tone}` }, label)),
    h('span', { class: 'small muted' }, quest.intent),
    h(
      'div',
      { class: 'criteria' },
      ...quest.criteria.map((c) =>
        h('div', { class: 'criterion' }, h('span', {}, cap(c.unit)), h('span', { class: 'xp' }, `${c.current} / ${c.required}`), meter(c.current / c.required, `${quest.title}: ${c.unit}`)),
      ),
    ),
    h(
      'div',
      { class: 'row between small' },
      h('span', { class: 'pill glow' }, `+${quest.reward.xp} ${cap(quest.reward.skill)} XP`),
      quest.minEvidence === 'self_reported' ? h('span', { class: 'muted grow' }, 'Manual entries count') : h('span', { class: 'grow' }),
      quest.status === 'active'
        ? button('Skip', async () => {
            await api.skipQuest(quest.id);
            await refresh();
          }, 'quiet')
        : null,
    ),
  );
}

function questsCard(view: HomeView, refresh: () => Promise<void>): HTMLElement {
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'quests' } },
    h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '🚀'), 'Quests'),
    h('p', { class: 'sub' }, 'Today’s and this week’s. Skipping is always fine.'),
    ...view.quests.map((quest) => questCard(quest, refresh)),
  );
}

function correctionControls(activity: ActivityView, refresh: () => Promise<void>, withConfirm: boolean): HTMLElement {
  const apply = (correction: Correction) => async () => {
    await api.correct(activity.id, correction);
    await refresh();
  };
  const retype = select([['', 'Change type…'], ...CORRECTABLE_TYPES.filter((t) => t !== activity.type).map((t) => [t, typeLabel(t)] as [string, string])], '', 'Change activity type');
  retype.addEventListener('change', () => {
    if (retype.value) void run(apply({ kind: 'recategorize', type: retype.value }));
  });
  return h(
    'div',
    { class: 'row' },
    withConfirm ? button('Looks right', apply({ kind: 'confirm' })) : null,
    retype,
    button('Discard', apply({ kind: 'discard' }), 'quiet'),
  );
}

function reviewCard(view: HomeView, refresh: () => Promise<void>): HTMLElement | null {
  if (view.review.length === 0) return null;
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'review' } },
    h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '🔭'), 'Needs your review'),
    h('p', { class: 'sub' }, 'These are held, not counted, until you look. Nothing is assumed to be cheating.'),
    h(
      'ul',
      { class: 'list' },
      ...view.review.map((activity) =>
        h(
          'li',
          {},
          h(
            'div',
            { class: 'grow' },
            h('div', {}, `${typeLabel(activity.type)} · ${duration(activity.minutes)}`, h('span', { class: 'time' }, ` · ${dayLabel(new Date(activity.start).toISOString().slice(0, 10))} ${clock(activity.start, view.account.timeZone)}`)),
            ...activity.reviewReasons.map((reason) => h('div', { class: 'small warn' }, reason)),
          ),
          correctionControls(activity, refresh, true),
        ),
      ),
    ),
  );
}

function activityCard(view: HomeView, refresh: () => Promise<void>): HTMLElement {
  const tz = view.account.timeZone;
  const items = view.activities.map((activity) => {
    const discarded = activity.userConfirmation === 'discarded';
    const award = activity.award;
    const xp = !award || discarded
      ? h('span', { class: 'muted small' }, discarded ? 'Discarded' : 'No XP')
      : award.status === 'reversed'
        ? h('span', { class: 'muted small' }, 'Reversed')
        : h('span', { class: 'xp' }, `${award.status === 'pending' ? '(' : ''}+${award.xp} XP${award.status === 'pending' ? ' held)' : ''}`);
    return h(
      'li',
      {},
      h(
        'details',
        { class: 'activity grow' },
        h(
          'summary',
          {},
          h('span', { class: 'time' }, `${clock(activity.start, tz)}–${clock(activity.end, tz)}`),
          h('span', { class: 'grow' }, typeLabel(activity.type), activity.category ? h('span', { class: 'muted' }, ` · ${cap(activity.category)}`) : null, activity.tags.includes('focus') ? h('span', { class: 'pill', style: { 'margin-left': '6px' } }, 'Focus') : null),
          h('span', { class: 'pill' }, EVIDENCE_LABELS[activity.evidenceLevel] ?? activity.evidenceLevel),
          h('span', { class: 'muted small' }, duration(activity.minutes)),
          xp,
        ),
        h(
          'div',
          { class: 'why' },
          ...(award ? award.explanation.map((line) => h('p', {}, line)) : [h('p', {}, 'No XP for this activity.')]),
          h('p', { class: 'muted' }, `Source: ${activity.sources.map((s) => (s === 'desktop-companion' ? 'LifeOS Companion' : s === 'manual-log' ? 'logged by you' : s)).join(', ')}`),
          discarded ? null : h('div', { style: { 'margin-top': '8px' } }, correctionControls(activity, refresh, false)),
        ),
      ),
    );
  });
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'activity' } },
    h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '🛰'), 'Flight log'),
    h('p', { class: 'sub' }, 'Today’s activity. Open an entry to see exactly how its XP was worked out, or to correct it.'),
    items.length ? h('ul', { class: 'list' }, ...items) : h('p', { class: 'empty' }, 'Nothing yet today. Focus sessions from LifeOS Companion appear here a few minutes after they end.'),
  );
}

function logCard(refresh: () => Promise<void>): HTMLElement {
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60_000);
  const type = select(MANUAL_TYPES.map((t) => [t, typeLabel(t)] as [string, string]), 'workout', 'Activity');
  const time = h('input', { attrs: { type: 'time', value: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`, 'aria-label': 'Start time' } });
  const minutes = h('input', { attrs: { type: 'number', min: '1', max: '360', value: '30', 'aria-label': 'Minutes' } });
  const km = h('input', { attrs: { type: 'number', min: '0', step: '0.1', placeholder: 'optional', 'aria-label': 'Distance in km' } });
  const form = h(
    'form',
    { class: 'form' },
    h('label', {}, 'Activity', type),
    h('label', {}, 'Started today at', time),
    h('label', {}, 'Minutes', minutes),
    h('label', {}, 'Distance (km)', km),
    h('button', { class: 'primary', attrs: { type: 'submit' } }, 'Log it'),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const [hours, mins] = time.value.split(':').map(Number);
    const startAt = new Date();
    startAt.setHours(hours ?? 0, mins ?? 0, 0, 0);
    const length = Number(minutes.value);
    void run(async () => {
      await api.logManual({
        type: type.value,
        start: startAt.getTime(),
        end: startAt.getTime() + length * 60_000,
        ...(km.value ? { distanceM: Math.round(Number(km.value) * 1000) } : {}),
      });
      toast('Logged. Self-reported entries earn provisional XP.');
      await refresh();
    });
  });
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '✍️'), 'Log something by hand'),
    h('p', { class: 'sub' }, 'For workouts, walks and anything away from the computer. Manual entries count for your own progress, not for rankings.'),
    form,
  );
}

function skillsCard(view: HomeView): HTMLElement {
  const list = h(
    'div',
    { attrs: { hidden: '' } },
    ...view.progress.domains.map((domain) =>
      h(
        'div',
        { class: 'domain' },
        h('div', { class: 'domain-name' }, cap(domain.domain)),
        ...domain.skills.map((s) =>
          h('div', { class: 'skill', attrs: { title: `${s.xp} XP` } }, h('span', {}, cap(s.skill)), meter(s.xpIntoLevel / Math.max(1, s.xpForNextLevel), `${cap(s.skill)} progress`), h('span', { class: 'lvl' }, `Lv ${s.level}`)),
        ),
      ),
    ),
  );
  const sky = constellation(view.progress, { show: showTip, hide: hideTip });
  const toggle = h('button', { class: 'link small', attrs: { type: 'button', 'aria-expanded': 'false' } }, 'Show as list');
  toggle.addEventListener('click', () => {
    const showList = list.hidden;
    list.hidden = !showList;
    sky.style.display = showList ? 'none' : '';
    toggle.setAttribute('aria-expanded', String(showList));
    toggle.textContent = showList ? 'Show the sky' : 'Show as list';
  });
  const lit = view.progress.domains.flatMap((d) => d.skills).filter((s) => s.xp > 0).length;
  const total = view.progress.domains.flatMap((d) => d.skills).length;
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'skills' } },
    h('div', { class: 'row between' }, h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '✨'), 'Skills'), toggle),
    h('p', { class: 'sub' }, `${lit} of ${total} stars lit. Each skill shines brighter as it levels up.`),
    sky,
    list,
  );
}

function medal(badge: BadgeView, compact = false): HTMLElement {
  const label = `${badge.name}: ${badge.earned ? 'earned' : `${badge.current} of ${badge.target}`}. ${badge.description}`;
  return h(
    'div',
    { class: `medal${badge.earned ? ' earned' : ''}`, attrs: compact ? { role: 'img', 'aria-label': label, title: label } : { 'data-badge': badge.id } },
    h('div', { class: 'disc', attrs: { 'aria-hidden': 'true' } }, BADGE_ICON[badge.id] ?? '🏅'),
    compact ? null : h('div', { class: 'name' }, badge.name),
    compact ? null : h('div', { class: 'desc' }, badge.description),
    compact || badge.earned ? null : meter(badge.current / badge.target, `${badge.name} progress`),
    compact ? null : h('div', { class: 'small muted' }, badge.earned ? 'Earned' : `${badge.current} / ${badge.target}`),
  );
}

function badgesCard(badges: readonly BadgeView[]): HTMLElement {
  const earned = badges.filter((b) => b.earned).length;
  // Earned first, then the closest to being earned.
  const shown = [...badges].sort((a, b) => Number(b.earned) - Number(a.earned) || b.current / b.target - a.current / a.target).slice(0, 6);
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'badges' } },
    h('div', { class: 'row between' }, h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '🏅'), 'Badges'), h('a', { class: 'small', attrs: { href: '#/badges' } }, `All ${badges.length} ›`)),
    h('p', { class: 'sub' }, `${earned} earned. Every badge is a real milestone.`),
    h('div', { class: 'badges compact' }, ...shown.map((b) => medal(b, true))),
  );
}

function awardsCard(view: HomeView): HTMLElement {
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '⚡'), 'Recent XP'),
    view.recentAwards.length
      ? h(
          'ul',
          { class: 'list' },
          ...view.recentAwards.slice(0, 8).map((award) =>
            h(
              'li',
              { class: 'small' },
              h('div', { class: 'grow' }, award.explanation[0] ?? '', award.status === 'reversed' ? h('div', { class: 'muted' }, `Reversed: ${award.reversalReason ?? ''}`) : null),
              h('span', { class: award.status === 'reversed' ? 'muted' : 'xp' }, award.status === 'reversed' ? `−${award.xp}` : `+${award.xp}`),
            ),
          ),
        )
      : h('p', { class: 'empty' }, 'XP shows up here, always with its reasons.'),
  );
}

// --- badges --------------------------------------------------------------------------------

async function showBadges(): Promise<void> {
  const view = await api.home();
  account = view.account;
  renderHeader(true);
  const changes = takeChanges(view);
  const earned = view.badges.filter((b) => b.earned).length;
  main.replaceChildren(
    h(
      'section',
      { class: 'card', attrs: { 'data-testid': 'badge-list' } },
      h('h2', {}, h('span', { class: 'icon', attrs: { 'aria-hidden': 'true' } }, '🏅'), `Badges · ${earned} of ${view.badges.length}`),
      h('p', { class: 'sub' }, 'Earned from what really happened. If evidence is corrected or deleted, its badge follows.'),
      h('div', { class: 'badges' }, ...view.badges.map((b) => medal(b))),
    ),
  );
  if (changes.moments.length) window.setTimeout(() => celebrate(changes.moments), 200);
}

// --- week -----------------------------------------------------------------------------------

function showTip(event: MouseEvent | FocusEvent, text: string): void {
  tooltip.textContent = text;
  tooltip.hidden = false;
  const target = event.currentTarget as HTMLElement;
  const box = target.getBoundingClientRect();
  tooltip.style.left = `${Math.min(window.innerWidth - 180, box.left + box.width / 2 - 60)}px`;
  tooltip.style.top = `${Math.max(8, box.top - 40)}px`;
}
const hideTip = () => (tooltip.hidden = true);

/** A hover/focus target larger than the mark it describes. */
function hit(el: HTMLElement, text: string): HTMLElement {
  el.classList.add('hit');
  el.tabIndex = 0;
  el.setAttribute('aria-label', text);
  el.addEventListener('mouseenter', (e) => showTip(e, text));
  el.addEventListener('focus', (e) => showTip(e, text));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('blur', hideTip);
  return el;
}

function dayChart(recap: RecapView): HTMLElement {
  const max = Math.max(1, ...recap.days.map((d) => d.minutes));
  const peak = recap.days.reduce((a, b) => (b.minutes > a.minutes ? b : a));
  const table = h(
    'table',
    { class: 'data', attrs: { hidden: '' } },
    h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Tracked'))),
    h('tbody', {}, ...recap.days.map((d) => h('tr', {}, h('td', {}, dayLabel(d.dateKey, 'long')), h('td', {}, duration(d.minutes))))),
  );
  const toggle = h('button', { class: 'link small', attrs: { type: 'button', 'aria-expanded': 'false' } }, 'Show as table');
  toggle.addEventListener('click', () => {
    const show = table.hidden;
    table.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
    toggle.textContent = show ? 'Hide table' : 'Show as table';
  });
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'days' } },
    h('div', { class: 'row between' }, h('h2', {}, 'Time tracked each day'), toggle),
    h(
      'div',
      { class: 'columns', attrs: { role: 'img', 'aria-label': `Tracked time per day, most on ${dayLabel(peak.dateKey, 'long')}` } },
      ...recap.days.map((d) => {
        const height = d.minutes > 0 ? `${Math.max(2, (d.minutes / max) * 100)}%` : '0';
        const slot = h(
          'div',
          { class: 'slot' },
          h('div', { class: 'col', style: { height } }),
          // Label only the peak; the tooltip and table carry the rest.
          d === peak && d.minutes > 0 ? h('span', { class: 'cap', style: { bottom: height } }, duration(d.minutes)) : null,
        );
        return hit(slot, `${dayLabel(d.dateKey, 'long')}: ${duration(d.minutes)}`);
      }),
    ),
    h('div', { class: 'axis', attrs: { 'aria-hidden': 'true' } }, ...recap.days.map((d) => h('span', {}, dayLabel(d.dateKey)))),
    table,
  );
}

function domainChart(recap: RecapView): HTMLElement {
  const max = Math.max(1, ...recap.domains.map((d) => d.minutes));
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'domains' } },
    h('h2', {}, 'Where your time went'),
    h('p', { class: 'sub' }, 'By life domain. XP shown alongside, never on a second axis.'),
    h(
      'div',
      { class: 'hbars' },
      ...recap.domains.map((d) =>
        h(
          'div',
          { class: 'hbar' },
          h('span', {}, cap(d.domain)),
          hit(
            h(
              'div',
              { class: 'track' },
              d.minutes > 0 ? h('div', { class: 'fill', style: { width: `${(d.minutes / max) * 80}%` } }) : null,
              h('span', { class: 'tip' }, d.minutes > 0 ? `${duration(d.minutes)} · ${d.xp} XP` : '—'),
            ),
            `${cap(d.domain)}: ${duration(d.minutes)}, ${d.xp} XP`,
          ),
        ),
      ),
    ),
  );
}

async function showWeek(week?: string): Promise<void> {
  const recap = await api.recap(week);
  renderHeader(true);
  const shift = (days: number) => {
    const date = new Date(`${recap.weekStart}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const isCurrent = recap.window.end > Date.now();
  const change = recap.previousWeekMinutes > 0 ? Math.round(((recap.totals.minutes - recap.previousWeekMinutes) / recap.previousWeekMinutes) * 100) : null;

  const feedback = h(
    'div',
    { class: 'row', attrs: { 'data-testid': 'feedback' } },
    h('span', {}, 'Did this recap represent your week?'),
    ...[true, false].map((accurate) =>
      button(accurate ? 'Yes' : 'Not really', async () => {
        await api.recapFeedback(recap.weekStart, accurate);
        toast(accurate ? 'Thanks — glad it rang true.' : 'Thanks. Corrections on the Today page make future recaps more accurate.');
        await showWeek(recap.weekStart);
      }, recap.feedback === accurate ? 'primary' : ''),
    ),
  );

  main.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row between' },
        h('a', { attrs: { href: `#/week/${shift(-7)}` } }, '‹ Previous week'),
        h('h1', { style: { margin: '0', 'font-size': '20px' } }, `${dayLabel(recap.weekStart, 'long')} – ${dayLabel(recap.weekEnd, 'long')}`),
        isCurrent ? h('span', { style: { width: '110px' } }) : h('a', { attrs: { href: `#/week/${shift(7)}` } }, 'Next week ›'),
      ),
      h(
        'div',
        { class: 'tiles' },
        h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Time tracked'), h('div', { class: 'value' }, duration(recap.totals.minutes)), change !== null ? h('div', { class: 'delta' }, `${change >= 0 ? '+' : '−'}${Math.abs(change)}% vs the week before`) : null),
        h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Sessions'), h('div', { class: 'value' }, recap.totals.sessions)),
        h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'XP earned'), h('div', { class: 'value' }, recap.totals.xp)),
        h('div', { class: 'card tile' }, h('div', { class: 'label' }, 'Quests completed'), h('div', { class: 'value' }, `${recap.quests.completed} of ${recap.quests.offered}`)),
      ),
      dayChart(recap),
      domainChart(recap),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'Intent and evidence'),
        h('p', { class: 'small' }, `Priorities: ${recap.priorities.done} done of ${recap.priorities.planned} planned. Corrections you made: ${recap.corrections}.`),
        recap.notes.length ? h('ul', { class: 'notes' }, ...recap.notes.map((note) => h('li', {}, note))) : null,
        h('div', { style: { 'margin-top': '14px' } }, feedback),
      ),
    ),
  );
}

void run(async () => {
  if ((await api.session()).signedIn) await render();
  else showSignIn();
});
