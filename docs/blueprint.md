# ECLIPSE + PROMETHEE
## Product Blueprint — v0.1

**Working thesis:** Build a multiplayer Life RPG where real, evidenced effort—on a computer and in the physical world—becomes progress, reputation, and community participation.

**Product promise:** “Make your real life playable, without making it fake.”

---

## 1. What is confirmed inspiration vs. original design

### Confirmed inspiration (not a claim of affiliation or feature copying)

- **Eclipse** and **Promethee** are the names and conceptual split provided by the founder: a life/progression surface and a tracking/intelligence layer.
- Familiar category patterns are useful references: Strava-style social activity, Discord-style community, Duolingo-style motivation, Notion-style planning, and RPG progression.
- The product must not reuse another company’s code, proprietary designs, branding, content, or undisclosed mechanics. A legal name/trademark search is required before launch.

### Original product ideas in this blueprint

- One normalized evidence pipeline for digital work and physical-life activity.
- An explicit **evidence-to-credit** model: tracked, connected, manually logged, and verified activities are distinct.
- A social Life RPG spanning work, health, learning, craft, and outdoor activity.
- Invite/access-code cohorts that participate in time-bounded seasons.
- A desktop-first “Promethee Companion” that is privacy-first, local-first where possible, and explainable about what it observes.

---

## 2. Brand roles and product boundary

| Product | Role | User value | Must not become |
|---|---|---|---|
| **ECLIPSE** | The social Life RPG and planning experience | A motivating home for identity, goals, quests, friends, guilds, and progress | A covert surveillance tool or generic task manager |
| **PROMETHEE** | The trusted data, context, and intelligence layer | Turns consenting sources into understandable activity evidence and recommendations | A social network, a raw health-data vault exposed to peers, or an opaque “truth machine” |

ECLIPSE owns the account, profile, gameplay rules, social graph, planning, and presentation. PROMETHEE owns source connections, event ingestion, normalization, confidence scoring, deduplication, and private insight generation. They can ship in one desktop installer at MVP, but should remain separately bounded services and domains.

---

## 3. Target users and jobs to be done

**Beachhead audience:** ambitious, digitally active 18+ creators, students, freelancers, founders, athletes, and hybrid workers who want their effort to count across work and life. Start with a narrow, invite-only cohort instead of “everyone.”

Primary jobs:

1. “Help me see whether I’m actually progressing in the areas I care about.”
2. “Turn a planned work, training, or learning session into a satisfying commitment I complete.”
3. “Make effort visible to trusted friends or a team without exposing my private life.”
4. “Give me a fair challenge with people like me, not a leaderboard I can game.”
5. “Help me recover when I fall behind; don’t shame me with a broken streak.”

Non-goals for the first three versions: medical advice, insurance/employer monitoring, child accounts, public location sharing by default, automatic psychological diagnosis, and a marketplace of financial rewards.

---

## 4. Core loops

### Daily loop — plan → act → evidence → reflect

1. User selects 1–3 priorities and accepts suggested quests in ECLIPSE.
2. They work, train, learn, create, or go outside.
3. PROMETHEE records or imports permitted evidence.
4. ECLIPSE turns qualified evidence into a completion, XP, skill progress, and a private recap.
5. The user corrects, confirms, or hides an inference; the model and rules improve.

### Weekly loop — review → adapt → recommit

ECLIPSE summarizes intent vs. evidence, celebrates wins, detects overload/imbalance, and offers a small number of next-week quests. User keeps, edits, or rejects recommendations.

### Social loop — join → contribute → compare fairly → belong

Users join a friend group or guild, complete a shared challenge, see privacy-safe progress, encourage others, and earn collective rewards. Comparative surfaces use brackets and/or normalized scoring—not raw hours alone.

### Seasonal loop — earn access → choose a path → compete/cooperate → legacy

An access-code cohort begins a 6–12 week season. Members choose a seasonal arc, build a record of meaningful activity, participate in challenges, receive end-of-season identity rewards, and opt into the next season. Seasons reset competitive standings; permanent personal history and cosmetics do not reset.

---

## 5. Feature inventory

### ECLIPSE

- Profile: avatar, privacy controls, selected skills, identity statement, season record.
- Life dashboard: today, quests, planned blocks, recent activity, balance indicators, private statistics.
- Goals/projects/tasks/habits: lightweight planning tied to a skill or quest; do not recreate full project-management software.
- RPG system: XP, levels, skill trees, titles, achievements, streak alternatives, collectibles/cosmetics.
- Quests: daily, weekly, personal, guild, challenge, and seasonal narrative quests.
- Social: friend requests, activity feed, reactions/comments, direct messages, guild chat, moderation/reporting.
- Leaderboards: friend, guild, country, global; opt-in and bracketed; filters by season, skill, and challenge.
- Challenges: creator-led or system-led challenges with explicit rules and evidence requirements.
- Recaps: daily/weekly/seasonal reflection and a shareable, redacted “achievement card.”

### PROMETHEE

- Desktop companion for macOS and Windows, with a visible status state, pause control, source controls, and event log.
- Digital activity collector: foreground app/window *category*, duration, idle state, optional calendar context, optional manual task association.
- Connector hub: OAuth/device connections, consent ledger, sync state, data deletion controls.
- Normalization and deduplication engine.
- Activity inference, confidence, verification, anomaly, and fraud-risk scoring.
- Private AI mentor context: user-approved goals, plans, summaries, and recent evidence—not unrestricted raw surveillance.
- User-visible correction queue: “We think this was a 45-minute video-editing session. Confirm, recategorize, or discard?”

---

## 6. MVP: prove the loop, not the entire universe

**MVP goal:** An invite-only desktop cohort can plan a day, have consenting desktop activity recognized, complete quests, level a few skills, and participate in a small trusted leaderboard.

Ship:

- Desktop app for **one OS first** (recommend macOS if that is the founding team’s daily environment), plus web/API-backed account service.
- Access-code onboarding, age gate, terms, consent screen, and a 6-week founding season.
- Manual goal/task/habit creation; daily and weekly quests; 5–8 fixed skills.
- Foreground-app category plus active duration/idle detection; manual session start/stop; per-app allow/deny list.
- Activity timeline and correction flow.
- XP, account level, skill progress, private weekly recap.
- Friends, invite-only groups (not full guild infrastructure), reactions, and friend leaderboard.
- One imported exercise source **only after its API/permissions are validated**; otherwise verified manual workout logging with timestamp and optional proof.
- Admin console: invite issuance, moderation, feature flags, season configuration, support/deletion queue.

Defer:

- Open global chat, global leaderboard, country ranking, GPS inference, automatic camera/shoot detection, guild wars, public API, AI agent autonomy, cash prizes, and multi-wearable support.

**MVP success signals:** 40%+ of activated users complete three tracked sessions in week one; 25%+ return in week four; 20%+ join a group/challenge; correction rate drops without a rise in false positives; no high-severity privacy incident.

---

## 7. Roadmap

### V2 — credible cross-domain life tracking

- Windows companion; mobile companion as a consent and sync surface.
- Calendar integration, richer desktop categorizations, focus sessions, project associations.
- One or two reliable activity connectors, followed by an adapter framework.
- Personal and guild quests; guild roles, chat channels, moderation, and challenge templates.
- Weekly AI mentor with explicit suggestions, citations to the user’s own activity, and one-click dismiss/adjust controls.
- Country leaderboard only after regional eligibility, abuse controls, and legal review.

### V3 — interoperable activity intelligence

- Apple Health/HealthKit through an iOS app; Android Health Connect; supported wearable/vendor connector set.
- GPS route-aware activities where users deliberately choose to import/share them.
- Multi-source deduplication, enhanced anti-cheat, seasonal divisions, global events, creator/community programs.
- Activity verification tiers, evidence appeals, trust/reputation controls, and a developer/partner integration program.

### Later / research track

- On-device activity inference, contextual “shoot mode,” computer vision/audio signals only if explicitly initiated and justified, and hardware partnerships. These are not prerequisites for the product’s first success.

---

## 8. System architecture

```text
Desktop Companion / Mobile Apps / Vendor Connectors
          │  encrypted, consented source events
          ▼
PROMETHEE Ingestion API ──► Raw-event vault (restricted)
          │
          ├─ schema validation / source provenance
          ├─ normalization / deduplication
          ├─ inference / confidence / verification
          ▼
Qualified Activity & Evidence Store ──► ECLIPSE Rules Engine
                                           │
                                           ├─ XP, skills, quests, seasons
                                           ├─ social-safe aggregates
                                           ▼
                                      ECLIPSE API & Clients
```

Recommended principles:

- **Event-driven core:** immutable source events, derived normalized activities, then separately versioned game awards. Never overwrite the evidence trail.
- **Rules versioning:** every XP award retains the rule version and evidence references that produced it, allowing transparent correction/reversal.
- **Local-first companion:** inspect, categorize, and aggregate desktop signals locally where feasible; upload the minimum needed for the selected feature.
- **Separate stores:** raw sensitive data, normalized private data, and social-display data must have different access paths and retention policies.
- **Feature flags:** each source, inference, leaderboard, and social visibility mode is remotely controllable.

---

## 9. Normalized activity model

All integrations translate into the same canonical types. Vendor payloads are retained only as necessary and behind a restricted provenance reference.

```text
ActivityEvent
  id, user_id, source_id, source_event_id, occurred_at, received_at
  type: digital_session | workout | walk | run | ride | outdoor_session |
        learning_session | creative_session | manual_log | other
  start_at, end_at, duration_seconds, timezone
  metrics: {distance_m, active_calories, steps, heart_rate_summary,
            elevation_m, keystroke_bucket?, active_seconds, ...}
  context: {app_category?, task_id?, project_id?, calendar_category?, tags[]}
  provenance: {source_kind, connector, import_method, device_class}
  visibility: private | friends | guild | public_summary
  evidence_level, confidence, verification_status
  raw_reference, consent_version, retention_policy

DerivedActivity
  id, event_ids[], canonical_type, interval, metrics, category, confidence
  duplicate_group_id, verification_status, user_confirmation

GameAward
  id, activity_id, award_type, xp, skill_allocations[], quest_id?
  rule_version, status: pending | awarded | reversed | appealed
```

Use capability-based metrics: a connector may provide duration and distance but not heart rate. Absence must never be interpreted as zero.

---

## 10. Activity, evidence, and verification model

Do not call inference “truth.” The system should present a confidence-ranked claim and let the user control it.

| Tier | Example | Game treatment |
|---|---|---|
| 0: self-reported | Manual “45 min strength training” | Private log; limited or provisional XP |
| 1: observed | Desktop active-duration session | Normal XP for personal progress; label as observed |
| 2: connected | Authorized provider’s completed workout | Full XP for most personal/community quests |
| 3: corroborated | Matching wearable workout + route or multiple independent signals | Eligible for higher-stakes leaderboard/challenge rules |
| 4: reviewed | Automated anomaly checks plus required human review | Reserved for special events, never routine life tracking |

**Inference examples:**

- A 70-minute active session in an allowed editing app can suggest `creative_session`; it cannot claim a commercial shoot occurred.
- A calendar event titled “Gym” is context, not proof of training.
- Location, heart rate, and routes are sensitive; they should never be required for ordinary XP.
- A user can recategorize, split, merge, reject, or make an event private. Corrections feed a personal preference model, not a global fact without review.

**Anti-cheat:** enforce rate limits, realistic duration bounds, overlap detection, device/source consistency checks, duplicate route/session detection where lawful, and server-side award reconciliation. Avoid “spyware” measures. For competitive rewards, use tier-gated eligibility, flags, appeals, and human moderation.

---

## 11. XP economy, levels, and skill trees

### Design rules

- Reward meaningful, sustainable effort—not raw busyness, dangerous exertion, or always-on monitoring.
- XP is non-transferable, has no cash value, and should not create pressure to disclose health/location data.
- Diminishing returns and daily/weekly caps prevent “hours farm” behavior.
- Let users choose skill allocation when an activity can reasonably support more than one path.
- Use recovery/rest/reflection quests so the system does not reward burnout.

### Example starter skill tree

| Domain | Skills |
|---|---|
| Mind | Learning, Focus, Reflection |
| Craft | Creation, Communication, Business |
| Body | Strength, Endurance, Mobility, Recovery |
| World | Adventure, Community, Discipline |

Each qualified session produces base XP from duration plus an intensity/quality modifier where available, then applies: source tier, repeat-diminishing curve, quest bonus, and safety/abuse caps. A simple initial model:

```text
awarded XP = min(session cap,
  base(type, duration) × evidence multiplier × quest multiplier × novelty/recovery factor)
```

Keep the exact numbers configurable and show an explanation: “25 Focus XP: 50 min confirmed focus block; 1.0× source multiplier; +5 quest bonus.”

**Levels:** account level is broad continuity; skill levels represent investment in a domain. Cosmetic unlocks, titles, quest access, and profile expression are safer rewards than power advantages in leaderboards.

---

## 12. Quest system

Quest anatomy: `intent + target + timeframe + eligible evidence + completion rule + reward + privacy mode`.

Quest types:

- **Daily:** “Complete one planned 25-minute Focus block.”
- **Weekly:** “Accumulate 150 minutes of movement across three days.”
- **Personal:** generated from a user-selected goal; user approves it.
- **Skill:** pursue a chosen skill path with varied activity, not endless repetition.
- **Guild:** pooled contribution with individual privacy preserved.
- **Challenge:** standardized public rules, verification tier, reporting, and appeal path.
- **Seasonal arc:** a 6–12 week “chapter” with milestones and a reflection, not merely a points race.

Quest authoring must use a constrained rule builder in early versions. Human-created public quests require moderation before discovery.

---

## 13. Social, guilds, and leaderboards

### Social model

Default profile and event visibility are private. The user chooses what a friend, guild, or public viewer can see: exact activity, category/duration only, achievement only, or nothing. Never expose exact routes, raw health measures, active window titles, or calendar details socially by default.

Guilds are small communities with membership approval, roles (owner/mod/member), chat, a shared goal, activity-summary feed, and moderation tools. Start with 5–50 members. Large “global guilds” create moderation and spam problems before they create value.

### Leaderboard rules

- Separate **personal record** from **competitive rank**.
- Offer friend, guild, country, and global boards only to opted-in eligible accounts.
- Rank by a bounded, bracketed seasonal score (for example, completed eligible quests plus diverse activity), not lifetime raw XP or steps.
- Brackets should consider skill/season tier and optionally declared play style; never infer sensitive characteristics.
- Public profiles show summaries, badges, and user-selected skills—not detailed evidence.
- Tie rules, audit logs, reports, disqualification, and appeal policy are necessary before prizes or high-prestige competition.

Chat requires blocking, reporting, rate limits, content policy, moderation workflow, and age/region controls from day one of public availability.

---

## 14. Access codes and seasons

Access codes are an onboarding and community-quality mechanism, not security.

- Code types: founding cohort, friend invite, partner/creator, staff/test, and recovery.
- Codes have campaign, expiry, redemption cap, optional region/age eligibility, and revocation state.
- One account per person policy should not demand invasive identity proof in MVP; use abuse signals and graduated friction.
- Each season has an ID, start/end, ruleset version, eligible quests, leaderboard schema, and archived recap.
- On season rollover: reset season score/rank and challenge eligibility; retain user-owned history, levels, cosmetics, friend graph, and private data subject to retention choices.
- A waitlist with referral codes can create momentum, but access language must not misrepresent scarcity or data use.

---

## 15. AI mentor

The mentor is a coach, not an authority. Its job is to help users plan, reflect, and make tradeoffs from data they deliberately share.

- Inputs: selected goals, planned tasks, user-confirmed activity summaries, skill progress, and opt-in calendar labels. Avoid raw screen text, raw health details, and private chat by default.
- Outputs: a suggested daily focus, weekly reflection, realistic quest options, and explanations such as “You planned four workouts but logged one; want to lower the target or schedule two shorter sessions?”
- Controls: source checklist, “why am I seeing this?”, edit/delete memory, no-health-advice mode, disable mentor, and report unsafe advice.
- Safety: no diagnosis, eating-disorder encouragement, exertion prescription, or coercive productivity language. Escalate sensitive patterns to supportive, non-clinical language and resources, not conclusions.

---

## 16. Privacy, security, and trust principles

1. **Consent is granular and reversible.** Ask separately for desktop categories, calendar, health/workout data, location/routes, and social sharing.
2. **Data minimization wins.** Collect app category/duration before window titles; aggregate before upload; do not capture keystrokes, screenshots, clipboard, microphone, or camera content for MVP.
3. **User agency.** Pause tracking, inspect events, correct them, export data, disconnect sources, and request deletion.
4. **Private by default.** Social disclosure is deliberate and scoped. Health/location data need stronger defaults.
5. **Security by design.** TLS in transit, encryption at rest, separate key/access boundaries for sensitive data, least privilege, audit logs, secure token storage/rotation, dependency scanning, penetration testing before broad launch.
6. **No hidden employment surveillance.** No employer dashboard, covert background agent, or shared productivity score without a distinct future product and legal/ethical review.
7. **Compliance is a product requirement.** Establish data maps, lawful bases, retention schedule, subprocessors, DPA process, incident response, and age/region policy before collecting health or location data.

---

## 17. Wearable and ecosystem strategy — validation gates

Build an adapter interface first; add providers only when their official developer agreement, scopes, platform rules, commercial eligibility, sync model, rate limits, and deletion requirements have been confirmed.

| Ecosystem | Likely route | Key constraint to verify |
|---|---|---|
| Apple Watch / Health | iOS app reads user-authorized HealthKit data | HealthKit entitlement, data-use rules, App Store review, background delivery, and no direct server access without the phone app |
| Android watches / phones | Android companion + Health Connect | Permission model, background sync, Android version coverage |
| Garmin | Official developer/partner APIs if approved | Commercial access, OAuth/data permissions, review/partner requirements |
| Amazfit / Zepp | Official partner/developer path if available | Whether third-party access is public, supported metrics, and terms |
| Oura | OAuth/API integration, subject to terms | Rate limits, commercial permissions, sensitive readiness/health handling |
| Fitbit | OAuth/API integration subject to current platform availability | Current developer access, scopes, rate limits, and branding requirements |
| Strava | OAuth/API integration | Developer agreement, upload/read scopes, rate limits, athlete privacy, and route handling |

The launch order should be driven by user demand *and verified access*, not brand recognition. Store connector capabilities declaratively so a workout from any source maps into canonical activities without product-wide special cases.

---

## 18. Desktop tracking strategy

1. Ship a visible, signed companion app that asks permission in plain language.
2. Track only session-level active time, idle time, app/process identity, and a user-controlled category mapping. Do not collect content.
3. Use an explicit “focus session” mode to improve intent association; automatic classification remains a suggestion.
4. Give users an always-available pause switch, per-app exclusions, a local timeline, and a “delete last hour/day” action.
5. Treat OS permissions (especially accessibility/activity permissions) as sensitive; explain why they are requested and gracefully degrade when declined.
6. Keep raw observations local where possible; upload derived intervals only when necessary for cross-device sync and enabled gameplay.

Technical validation: macOS and Windows API capability, entitlement/notarization requirements, background execution behavior, power impact, OS permission wording, and whether foreground-window metadata can be used consistent with platform policy and the privacy notice.

---

## 19. Monetization hypotheses

Test value, not addiction:

- **Free core:** private dashboard, basic tracking, personal quests, limited social features.
- **ECLIPSE Plus:** richer insight history, advanced planning, custom quests/skill trees, expanded recap/design options, and additional integrations.
- **Guild plans:** optional paid admin tools, private branded seasons, analytics limited to consented aggregates, and enhanced moderation—not employee surveillance.
- **Season pass/cosmetics:** only cosmetic or convenience rewards; no pay-to-win leaderboard advantages.
- **Partner programs:** carefully selected creator/community seasons; no sale of identifiable health/activity data.

Price and packaging require willingness-to-pay research. Avoid ads based on health, location, productivity, or private activity.

---

## 20. Launch strategy

### Phase 0: founding research (4–6 weeks)

- Interview 25–40 target users across creators, students, fitness-focused users, and hybrid workers.
- Test the core promise, privacy language, mock recaps, and two or three XP/quest prototypes.
- Recruit 30–100 founding members who understand that the product is early and invite-only.
- Secure legal review of names, privacy policy approach, terms, community rules, and the first data sources.

### Phase 1: private founding season

- One platform, small invite groups, no public feed, no prizes.
- Founder-led onboarding and weekly qualitative review of tracking accuracy, motivation, and discomfort.
- Publish a transparent changelog and “what we collect” page.

### Phase 2: referral-led cohorts

- Open curated access codes, small guild pilots, community challenges, creator partners, and a waitlist.
- Expand only when moderation response times, retention, accuracy, and deletion/support operations are healthy.

The best launch story is not “we track everything.” It is “your real effort—creative, physical, and focused—can belong to one fair, private progression system.”

---

## 21. Build sequence

1. Establish brand/name clearance, user research, consent/data map, threat model, and event taxonomy.
2. Build account/access-code/season service; privacy settings; audit-ready activity event pipeline.
3. Build one desktop companion with manual focus sessions, app-category tracking, idle handling, pause/exclusions, and local event review.
4. Build ECLIPSE home, goal/task/habit model, basic quest rule engine, XP explanation, skills, and weekly recap.
5. Add trusted friends/groups and a tightly scoped seasonal leaderboard; instrument retention, accuracy, corrections, and abuse.
6. Operate one founding season; fix the motivation and trust loop before adding more sources.
7. Add a validated activity connector through the adapter layer and solve deduplication/visibility end-to-end.
8. Add guilds/challenges/moderation, then AI mentor; add mobile and wearable paths only as their platform gates clear.
9. Add country/global competition after anti-cheat, governance, privacy, and regional legal requirements are proven.

---

## 22. Decisions required before implementation

1. Initial OS: macOS-only, Windows-only, or which has the strongest founding cohort?
2. Initial activity domain: focus/creative work only, or one verified fitness connector in the first season?
3. Competitive posture: collaborative guild challenges only at launch, or a small friend leaderboard too?
4. Minimum age and launch countries, which affect consent, moderation, and privacy obligations.
5. Whether users can earn rewards of monetary value. Recommendation: **no** until verification and anti-cheat systems mature.
6. Legal availability of the names **ECLIPSE** and **PROMETHEE** in target classes/territories.

## 23. Validation checklist — do before promising a feature

- Confirm current official developer access, commercial terms, scopes, rate limits, branding rules, and deletion obligations for every wearable/provider.
- Confirm Apple/Google desktop/mobile platform rules and required permissions/entitlements for tracking behavior and health data.
- Obtain specialist privacy/legal review for target markets, especially health, location, minors, biometrics, and international data transfers.
- Threat-model OAuth tokens, raw-event storage, social visibility bugs, account takeover, abuse/harassment, and leaderboard fraud.
- Test activity-classification false positives with real users; offer user correction before using in competitive contexts.
- Validate naming/trademark, domain availability, community guidelines, and customer-support capability before public launch.

---

## North-star metric

**Weekly Meaningful Progress Rate:** the percentage of active users who complete at least one user-chosen, evidence-supported quest and report that the recap accurately represented their week.

This combines behavior with trust. High engagement without trust is not success for ECLIPSE + PROMETHEE.
