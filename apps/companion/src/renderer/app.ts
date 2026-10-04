import { localDateKey } from '@lifeos/contracts';
import type { AccountView, AppsView, CompanionApi, CompanionState, TimelineView, UncategorizedApp } from '../shared/api.js';
import { categoryLabel, formatClock, formatDay, formatDuration } from '../shared/format.js';

declare global {
  interface Window {
    readonly lifeos: CompanionApi;
  }
}

const api = window.lifeos;
const header = document.getElementById('header')!;
const main = document.getElementById('main')!;
const toastEl = document.getElementById('toast')!;

let state: CompanionState;
let dateKey = '';
let timeline: TimelineView | null = null;
let apps: AppsView | null = null;
let account: AccountView | null = null;

// --- tiny DOM helper: text only, never innerHTML (app names come from other apps) ---

type Child = Node | string | number | null | undefined | false;
interface Props {
  class?: string;
  id?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration> & Record<string, string>;
  onclick?: () => void;
  attrs?: Record<string, string>;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.title) el.title = props.title;
  if (props.onclick) el.addEventListener('click', props.onclick);
  for (const [key, value] of Object.entries(props.attrs ?? {})) el.setAttribute(key, value);
  for (const [key, value] of Object.entries(props.style ?? {})) el.style.setProperty(key, String(value));
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'number' ? String(child) : child);
  }
  return el;
}

function button(label: string, onClick: () => Promise<unknown> | void, kind = ''): HTMLButtonElement {
  return h('button', { class: kind, onclick: () => void run(onClick) }, label);
}

async function run(task: () => Promise<unknown> | void): Promise<void> {
  try {
    await task();
  } catch (error) {
    toast(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error));
  }
}

let toastTimer: number | undefined;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4000);
}

const today = () => localDateKey(Date.now(), state.timeZone);
const swatch = (category: string) => h('span', { class: 'swatch', style: { background: `var(--cat-${category})` } });

// --- header ---------------------------------------------------------------------

function statusText(): string {
  switch (state.status) {
    case 'needs_consent':
      return 'Not tracking';
    case 'paused':
      return state.pausedUntil === null ? 'Paused' : `Paused until ${formatClock(state.pausedUntil, state.timeZone)}`;
    case 'idle':
      return 'Idle';
    case 'tracking':
      return state.detectorRunning ? 'Tracking' : 'App detection unavailable';
  }
}

function renderHeader(): void {
  const controls: Child[] = [];
  if (state.status !== 'needs_consent') {
    if (state.focusStartedAt === null) {
      controls.push(button('Start focus session', async () => (state = await api.startFocus())));
    } else {
      const elapsed = formatDuration((Date.now() - state.focusStartedAt) / 60_000);
      controls.push(button(`Stop focus · ${elapsed}`, async () => (state = await api.stopFocus()), 'primary'));
    }
    if (state.status === 'paused') {
      controls.push(button('Resume', async () => (state = await api.resume())));
    } else {
      const select = h(
        'select',
        { attrs: { 'aria-label': 'Pause tracking' } },
        h('option', { attrs: { value: '' } }, 'Pause…'),
        h('option', { attrs: { value: '30' } }, 'For 30 minutes'),
        h('option', { attrs: { value: '60' } }, 'For 1 hour'),
        h('option', { attrs: { value: 'tomorrow' } }, 'Until tomorrow'),
        h('option', { attrs: { value: 'indefinite' } }, 'Until I resume'),
      );
      select.addEventListener('change', () => {
        const value = select.value;
        if (!value) return;
        const duration = value === '30' || value === '60' ? (Number(value) as 30 | 60) : (value as 'tomorrow' | 'indefinite');
        void run(async () => (state = await api.pause(duration)));
      });
      controls.push(select);
    }
  }
  header.replaceChildren(
    h('span', { class: 'brand' }, 'LifeOS Companion'),
    h('span', { class: `pill ${state.status}`, attrs: { 'data-testid': 'status' } }, statusText()),
    h('span', { class: 'spacer' }),
    ...controls.filter((c): c is Node => c instanceof Node),
  );
}

// --- consent ----------------------------------------------------------------------

function privacyFacts(): HTMLElement[] {
  return [
    h('h3', {}, 'What it records'),
    h(
      'ul',
      { class: 'records' },
      h('li', {}, 'Which app is in front, every 5 seconds: its identifier and name, for example “Final Cut Pro”.'),
      h('li', {}, 'Whether you are active or idle, from the time since your last keypress or click. Never which keys.'),
      h('li', {}, 'When you start and stop a focus session.'),
    ),
    h('h3', {}, 'What it never records'),
    h(
      'ul',
      { class: 'never' },
      h('li', {}, 'Window titles, document or file names, web addresses'),
      h('li', {}, 'Keystrokes, screenshots, clipboard, microphone or camera'),
      h('li', {}, 'Anything from apps you exclude'),
    ),
    h('h3', {}, 'Where it goes'),
    h(
      'p',
      {},
      'It stays on this Mac, in a folder only your account can read, and raw records are deleted after 30 days. ' +
        'Nothing is uploaded unless you sign in to LifeOS and turn uploads on. Then only finished sessions are sent, as categories, times and durations, never app names. ' +
        'An app only counts toward progress after you put it in a category.',
    ),
    h('h3', {}, 'Your controls'),
    h('p', {}, 'Pause from the menu bar at any time, exclude apps, delete the last hour, a day, or everything, and turn tracking off.'),
  ];
}

function renderConsent(): void {
  main.replaceChildren(
    h(
      'section',
      { class: 'card consent', id: 'privacy' },
      h('h1', {}, 'Before anything is recorded'),
      h('p', { class: 'muted' }, 'LifeOS Companion turns time in apps you choose into progress. Here is exactly what that involves.'),
      ...privacyFacts(),
      h(
        'div',
        { class: 'row', style: { marginTop: '18px' } },
        button('Allow tracking', async () => {
          state = await api.grantConsent();
          renderAll();
          await loadData();
        }, 'primary'),
        button('Not now', () => window.close()),
      ),
      h('p', { class: 'muted small' }, `Privacy notice ${state.privacyNoticeVersion}`),
    ),
  );
}

// --- dashboard --------------------------------------------------------------------

function renderDashboard(): void {
  main.replaceChildren(accountCard(), dayCard(), uncategorizedCard(), appsCard(), privacyCard());
}

// --- account ------------------------------------------------------------------------

function input(attrs: Record<string, string>): HTMLInputElement {
  return h('input', { class: 'field', attrs });
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'form-field' }, h('span', { class: 'small muted' }, label), control, hint ? h('span', { class: 'small muted' }, hint) : null);
}

/** Swaps just the account card, so typing elsewhere isn't disturbed. */
function renderAccount(): void {
  document.getElementById('account')?.replaceWith(accountCard());
}

function accountCard(): HTMLElement {
  const card = (...children: Child[]) => h('section', { class: 'card', id: 'account', attrs: { 'data-testid': 'account' } }, h('h2', {}, 'LifeOS account'), ...children);
  if (!account) return card(h('p', { class: 'muted' }, 'Loading…'));
  const set = (next: AccountView) => {
    account = next;
    renderAccount();
  };
  const notice = account.notice ? h('p', { class: 'warn' }, account.notice) : null;

  switch (account.status) {
    case 'signed_out': {
      const email = input({ type: 'email', autocomplete: 'email', placeholder: 'you@example.com', 'aria-label': 'Email' });
      const send = button('Email me a code', async () => set(await api.startSignIn(email.value)), 'primary');
      email.addEventListener('keydown', (event) => event.key === 'Enter' && send.click());
      return card(
        h('p', { class: 'muted' }, 'Connect this Mac to your LifeOS account so your focused time counts toward quests and progress. Signing in uploads nothing by itself.'),
        notice,
        h('div', { class: 'row' }, email, send),
      );
    }
    case 'awaiting_code': {
      const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456', 'aria-label': 'Sign-in code' });
      const verify = button('Continue', async () => set(await api.verifyCode(code.value)), 'primary');
      code.addEventListener('keydown', (event) => event.key === 'Enter' && verify.click());
      return card(
        h('p', {}, 'Enter the six-digit code we sent to ', h('strong', {}, account.email ?? ''), '.'),
        h('div', { class: 'row' }, code, verify),
        h(
          'div',
          { class: 'row' },
          button('Send a new code', async () => set(await api.startSignIn(account!.email ?? '')), 'link'),
          button('Use a different email', async () => set(await api.cancelSignIn()), 'link'),
        ),
      );
    }
    case 'registration_required': {
      const accessCode = input({ placeholder: 'ABCD-1234', autocomplete: 'off', 'aria-label': 'Access code' });
      const name = input({ maxlength: '40', autocomplete: 'nickname', 'aria-label': 'Name' });
      const birthDate = input({ type: 'date', 'aria-label': 'Date of birth' });
      const region = input({ maxlength: '2', placeholder: 'FR', autocomplete: 'country', 'aria-label': 'Country code', class: 'field short' });
      const terms = h('input', { attrs: { type: 'checkbox' } });
      return card(
        h('p', {}, 'No LifeOS account uses ', h('strong', {}, account.email ?? ''), ' yet. LifeOS is invite-only for now: create your account with an access code.'),
        h(
          'div',
          { class: 'form' },
          field('Access code', accessCode),
          field('Name others will see', name),
          field('Date of birth', birthDate, 'Only used to confirm you are 18 or older. It is not stored.'),
          field('Country (two letters)', region),
        ),
        h('label', { class: 'row small' }, terms, `I am 18 or older and accept the LifeOS terms (${account.termsVersion ?? ''}).`),
        h(
          'div',
          { class: 'row', style: { marginTop: '10px' } },
          button('Create account', async () =>
            set(await api.register({ accessCode: accessCode.value, displayName: name.value, birthDate: birthDate.value, region: region.value, acceptTerms: terms.checked })),
          'primary'),
          button('Cancel', async () => set(await api.cancelSignIn()), 'link'),
        ),
      );
    }
    case 'signed_in':
      return card(
        h('p', {}, 'Signed in as ', h('strong', {}, account.displayName ?? ''), h('span', { class: 'muted' }, ` · ${account.email ?? ''}`)),
        account.staysSignedIn ? null : h('p', { class: 'muted small' }, 'This Mac can’t store your sign-in securely, so you will sign in again after quitting.'),
        uploadControls(account, set),
        h(
          'div',
          { class: 'row', style: { marginTop: '10px' } },
          button('Open your LifeOS home', () => api.openHome(), 'primary'),
          button('Sign out', async () => set(await api.signOut()), 'link'),
        ),
      );
  }
}

function uploadControls(view: AccountView, set: (next: AccountView) => void): HTMLElement {
  const upload = view.upload;
  const toggle = h('input', { attrs: { type: 'checkbox', 'data-testid': 'upload-toggle' } });
  toggle.checked = upload.enabled;
  toggle.addEventListener('change', () => void run(async () => set(await api.setUpload(toggle.checked))));

  let status: Child = null;
  if (upload.syncing) status = h('span', { class: 'muted' }, 'Uploading…');
  else if (upload.lastError) status = h('span', { class: 'warn' }, upload.lastError);
  else if (upload.lastSyncAt && upload.lastResult) {
    const n = upload.lastResult.accepted;
    status = h('span', { class: 'muted' }, `Last upload ${formatClock(upload.lastSyncAt, state.timeZone)}: ${n} new session${n === 1 ? '' : 's'}.`);
  }

  return h(
    'div',
    { class: 'upload' },
    h('label', { class: 'row' }, toggle, h('strong', {}, 'Upload desktop activity to my account')),
    h(
      'p',
      { class: 'muted small' },
      'Sends finished sessions as categories, times and durations, never app names or window titles, a few minutes after each one ends. ' +
        (upload.since ? `Starts with activity from ${new Date(upload.since).toLocaleDateString()}.` : 'Starts with today’s activity.') +
        ' Deleting activity here also deletes it from your account.',
    ),
    h(
      'div',
      { class: 'row', attrs: { 'data-testid': 'upload-status' } },
      status,
      upload.pendingDeletes > 0 ? h('span', { class: 'muted' }, `${upload.pendingDeletes} deletion${upload.pendingDeletes === 1 ? '' : 's'} waiting to reach your account.`) : null,
      upload.enabled && !upload.syncing ? button('Upload now', async () => set(await api.syncNow()), 'link') : null,
    ),
  );
}

function dayCard(): HTMLElement {
  const view = timeline;
  const shift = (direction: -1 | 1) => () => {
    if (!view) return;
    dateKey = localDateKey(direction < 0 ? view.window.start - 1 : view.window.end, state.timeZone);
    return loadData();
  };
  const isToday = dateKey === today();
  const nav = h(
    'div',
    { class: 'day-nav' },
    button('‹', shift(-1), 'link'),
    h('strong', { attrs: { 'data-testid': 'day' } }, formatDay(dateKey, today())),
    isToday ? h('span', { style: { width: '34px' } }) : button('›', shift(1), 'link'),
  );
  const total = view ? view.totals.reduce((sum, t) => sum + t.minutes, 0) : 0;

  if (!view) return h('section', { class: 'card' }, nav);
  const span = view.window.end - view.window.start;
  const pct = (at: number) => `${(((at - view.window.start) / span) * 100).toFixed(3)}%`;
  const width = (a: number, b: number) => `${(((b - a) / span) * 100).toFixed(3)}%`;

  const strip = h(
    'div',
    { class: 'strip', attrs: { role: 'img', 'aria-label': `Timeline: ${formatDuration(total)} tracked` } },
    ...view.sessions.map((s) =>
      h('div', {
        class: 'block',
        title: `${categoryLabel(s.category)} · ${formatClock(s.start, state.timeZone)}–${formatClock(s.end, state.timeZone)}`,
        style: { left: pct(s.start), width: width(s.start, s.end), background: `var(--cat-${s.category})` },
      }),
    ),
    ...view.focusBlocks.map((b) => h('div', { class: 'focus', style: { left: pct(b.start), width: width(b.start, b.end) } })),
    isToday ? h('div', { class: 'now', style: { left: pct(Date.now()) } }) : null,
  );

  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'timeline' } },
    h('div', { class: 'row between' }, nav, h('span', { class: 'muted' }, `${formatDuration(total)} tracked`)),
    strip,
    h('div', { class: 'hours' }, ...['00', '06', '12', '18', '24'].map((hour) => h('span', {}, hour))),
    view.totals.length
      ? h('div', { class: 'chips' }, ...view.totals.map((t) => h('span', { class: 'chip' }, swatch(t.category), `${categoryLabel(t.category)} · ${formatDuration(t.minutes)}`)))
      : h('p', { class: 'empty' }, isToday ? 'Nothing tracked yet today. Put an app you use in a category below to start.' : 'Nothing tracked this day.'),
    view.sessions.length
      ? h(
          'ul',
          { class: 'list' },
          ...view.sessions.map((s) =>
            h(
              'li',
              {},
              swatch(s.category),
              h('span', { class: 'grow' }, `${formatClock(s.start, state.timeZone)}–${formatClock(s.end, state.timeZone)} · ${categoryLabel(s.category)}`),
              s.focus ? h('span', { class: 'tag' }, 'Focus') : null,
              h('span', { class: 'muted' }, formatDuration(s.activeMinutes)),
            ),
          ),
        )
      : null,
  );
}

function categorySelect(selected: string | null, placeholder: string): HTMLSelectElement {
  const select = h('select', { attrs: { 'aria-label': 'Category' } }, h('option', { attrs: { value: '' } }, placeholder));
  for (const category of apps?.categories ?? []) {
    const option = h('option', { attrs: { value: category } }, categoryLabel(category));
    if (category === selected) option.selected = true;
    select.append(option);
  }
  return select;
}

function uncategorizedRow(app: UncategorizedApp): HTMLElement {
  const select = categorySelect(app.suggestion, 'Choose a category…');
  return h(
    'li',
    { attrs: { 'data-app': app.appId } },
    h('div', { class: 'grow' }, h('div', { class: 'name' }, app.name), h('div', { class: 'muted small' }, `${formatDuration(app.minutes)} in front`, app.suggestion ? ' · suggestion selected' : '')),
    select,
    button('Track', async () => {
      if (!select.value) return toast('Choose a category first.');
      apps = await api.setCategory(app.appId, select.value);
      await loadData();
    }),
    button('Exclude', async () => {
      apps = await api.setExcluded(app.appId, true);
      await loadData();
    }, 'link'),
  );
}

function uncategorizedCard(): HTMLElement {
  const list = timeline?.uncategorized ?? [];
  return h(
    'section',
    { class: 'card', attrs: { 'data-testid': 'uncategorized' } },
    h('h2', {}, 'Apps without a category'),
    h('p', { class: 'muted' }, 'These were in front this day but count toward nothing until you choose a category. Excluding an app stops recording it and deletes what was recorded.'),
    list.length ? h('ul', { class: 'list' }, ...list.map(uncategorizedRow)) : h('p', { class: 'empty' }, 'None.'),
  );
}

function appsCard(): HTMLElement {
  const mapped = apps?.mapped ?? [];
  const excluded = apps?.excluded ?? [];
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Your apps'),
    h('h3', {}, 'Tracked'),
    mapped.length
      ? h(
          'ul',
          { class: 'list' },
          ...mapped.map((app) => {
            const select = categorySelect(app.category, 'Stop tracking');
            select.addEventListener('change', () =>
              void run(async () => {
                apps = await api.setCategory(app.appId, select.value || null);
                await loadData();
              }),
            );
            return h('li', {}, swatch(app.category), h('span', { class: 'grow name' }, app.name), select);
          }),
        )
      : h('p', { class: 'empty' }, 'No apps yet.'),
    h('h3', {}, 'Excluded'),
    excluded.length
      ? h(
          'ul',
          { class: 'list' },
          ...excluded.map((app) =>
            h(
              'li',
              {},
              h('span', { class: 'grow name' }, app.name),
              button('Allow again', async () => {
                apps = await api.setExcluded(app.appId, false);
                await loadData();
              }, 'link'),
            ),
          ),
        )
      : h('p', { class: 'empty' }, 'None.'),
  );
}

function privacyCard(): HTMLElement {
  const wipe = h('input', { attrs: { type: 'checkbox', id: 'wipe' } });
  return h(
    'section',
    { class: 'card', id: 'privacy' },
    h('h2', {}, 'Privacy and your data'),
    ...privacyFacts(),
    h('h3', {}, 'Delete'),
    h(
      'div',
      { class: 'row' },
      button('Delete the last hour', async () => {
        state = await api.forget('last_hour');
        await loadData();
      }, 'danger'),
      button('Delete this day', async () => {
        state = await api.forget('today');
        await loadData();
      }, 'danger'),
      button('Delete everything', async () => {
        state = await api.forget('everything');
        await loadData();
      }, 'danger'),
    ),
    h('h3', {}, 'Export'),
    h('p', { class: 'muted' }, 'Saves the shown day as categories, times and durations, in the format the LifeOS service will accept. No app names.'),
    button('Export this day…', async () => {
      const result = await api.exportDay(dateKey);
      if (result.kind === 'saved') toast(`Saved ${result.events} session${result.events === 1 ? '' : 's'}.`);
      else if (result.kind === 'empty') toast('Nothing to export for this day.');
    }),
    h('h3', {}, 'Turn off'),
    h(
      'div',
      { class: 'row' },
      button('Turn off tracking', async () => {
        state = await api.revokeConsent(wipe.checked);
        renderAll();
      }, 'danger'),
      h('label', { class: 'row small muted' }, wipe, 'and delete recorded activity'),
    ),
    h('p', { class: 'muted small' }, state.consentGrantedAt ? `Allowed ${new Date(state.consentGrantedAt).toLocaleString()} · notice ${state.privacyNoticeVersion}` : ''),
  );
}

// --- data flow --------------------------------------------------------------------

function renderAll(): void {
  renderHeader();
  if (state.status === 'needs_consent') renderConsent();
  else renderDashboard();
}

async function loadData(): Promise<void> {
  if (state.status === 'needs_consent') return renderAll();
  [timeline, apps, account] = await Promise.all([api.getTimeline(dateKey), api.getApps(), api.getAccount()]);
  renderAll();
}

function scrollToSection(section: string): void {
  document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function init(): Promise<void> {
  state = await api.getState();
  dateKey = today();
  api.onStateChanged((next) => {
    const consentChanged = (next.status === 'needs_consent') !== (state.status === 'needs_consent');
    state = next;
    if (consentChanged) void run(loadData);
    else renderHeader();
  });
  api.onNavigate(scrollToSection);
  api.onAccountChanged((next) => {
    account = next;
    if (state.status !== 'needs_consent') renderAccount();
  });
  await loadData();
  if (location.hash === '#privacy') scrollToSection('privacy');
  window.setInterval(() => {
    renderHeader();
    // Don't redraw under the user's hands (e.g. an open category menu).
    const busy = document.activeElement instanceof HTMLSelectElement || document.activeElement instanceof HTMLInputElement;
    if (!busy && dateKey === today() && state.status !== 'needs_consent') void run(loadData);
  }, 60_000);
}

void run(init);
