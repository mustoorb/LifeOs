import { DAY } from '@lifeos/contracts';
import { describe, expect, it } from 'vitest';
import {
  FRIEND_LEADERBOARD,
  MINIMUM_AGE,
  archiveSeason,
  computeSeasonScore,
  createAccessCode,
  enrollInSeason,
  generateCode,
  normalizeCode,
  rankLeaderboard,
  redeemAccessCode,
  revokeAccessCode,
  seasonStatus,
  validateSeason,
  type GameAward,
  type Season,
} from '../src/index.js';
import { T0, at } from './fixtures.js';

const season: Season = {
  id: 'founding-1',
  name: 'Founding Season',
  window: { start: T0 - DAY, end: T0 - DAY + 42 * DAY },
  xpRulesetVersion: 'xp-v1',
  questIds: [],
  leaderboard: FRIEND_LEADERBOARD,
  campaigns: ['founding'],
};

function questAward(questId: string, status: GameAward['status'], seasonId = season.id): GameAward {
  return {
    id: `q-${questId}`,
    userId: 'u1',
    awardType: 'quest_completion',
    questId,
    seasonId,
    localDate: '2026-10-05',
    xp: 5,
    skillAllocations: [],
    ruleVersion: 'quest-v1',
    status,
    explanation: [],
    createdAt: T0,
  };
}

describe('seasons', () => {
  it('validates length and lifecycle', () => {
    expect(validateSeason(season)).toEqual([]);
    expect(validateSeason({ ...season, window: { start: T0, end: T0 + 14 * DAY } })).toEqual(['Seasons run 6–12 weeks']);
    expect(seasonStatus(season, T0 - 2 * DAY)).toBe('upcoming');
    expect(seasonStatus(season, T0)).toBe('active');
    expect(seasonStatus(season, season.window.end)).toBe('ended');
  });

  it('enrolls eligible campaigns once, and archives only after the end', () => {
    const request = { userId: 'u1', campaign: 'founding', leaderboardOptIn: true, bracket: 'rookie', now: T0 };
    const first = enrollInSeason(season, [], request);
    if (!first.ok) throw new Error(first.reason);
    expect(enrollInSeason(season, [first.enrollment], request)).toEqual({ ok: false, reason: 'already_enrolled' });
    expect(enrollInSeason(season, [], { ...request, campaign: 'partner-x' })).toEqual({
      ok: false,
      reason: 'campaign_not_eligible',
    });

    expect(() => archiveSeason(season, new Map(), [first.enrollment], T0)).toThrow();
    const archive = archiveSeason(season, new Map([['rookie', [{ userId: 'u1', score: 40, rank: 1 }]]]), [first.enrollment], season.window.end);
    expect(archive).toMatchObject({ participants: 1, finalStandings: { rookie: [{ userId: 'u1', rank: 1 }] } });
  });
});

describe('season score', () => {
  it('is bounded, ignores provisional completions and needs observed evidence', () => {
    const score = computeSeasonScore(
      season.id,
      season.window,
      FRIEND_LEADERBOARD,
      [
        questAward('a', 'awarded'),
        questAward('a', 'awarded'), // duplicate quest counts once
        questAward('b', 'provisional'),
        questAward('c', 'awarded', 'other-season'),
      ],
      [
        at(0, 30),
        at(60, 30, { canonicalType: 'creative_session' }),
        at(8 * 24 * 60, 30, { canonicalType: 'run', evidenceLevel: 'connected' }),
        at(0, 30, { canonicalType: 'walk', evidenceLevel: 'self_reported' }),
        at(0, 30, { canonicalType: 'learning_session', verificationStatus: 'flagged' }),
      ],
    );
    expect(score).toEqual({ completedQuests: 1, distinctTypes: 3, activeWeeks: 2, score: 10 + 15 + 20 });

    const capped = computeSeasonScore(
      season.id,
      season.window,
      { ...FRIEND_LEADERBOARD, maxScore: 20 },
      [questAward('a', 'awarded')],
      [at(0, 30)],
    );
    expect(capped.score).toBe(20);
  });
});

describe('rankLeaderboard', () => {
  it('ranks opted-in eligible accounts per bracket with shared ranks for ties', () => {
    const ranked = rankLeaderboard([
      { userId: 'carol', bracket: 'rookie', score: 50, optedIn: true, eligible: true },
      { userId: 'alice', bracket: 'rookie', score: 80, optedIn: true, eligible: true },
      { userId: 'bob', bracket: 'rookie', score: 50, optedIn: true, eligible: true },
      { userId: 'dave', bracket: 'rookie', score: 40, optedIn: true, eligible: true },
      { userId: 'eve', bracket: 'rookie', score: 999, optedIn: false, eligible: true },
      { userId: 'mallory', bracket: 'rookie', score: 999, optedIn: true, eligible: false },
      { userId: 'zed', bracket: 'veteran', score: 10, optedIn: true, eligible: true },
    ]);
    expect(ranked.get('rookie')).toEqual([
      { userId: 'alice', score: 80, rank: 1 },
      { userId: 'bob', score: 50, rank: 2 },
      { userId: 'carol', score: 50, rank: 2 },
      { userId: 'dave', score: 40, rank: 4 },
    ]);
    expect(ranked.get('veteran')).toEqual([{ userId: 'zed', score: 10, rank: 1 }]);
  });
});

describe('access codes', () => {
  const fixedRandom = (bytes: Uint8Array) => bytes.map((_, i) => i * 37);

  it('generates readable codes and normalizes look-alike input', () => {
    expect(generateCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeCode(' ab1o-lzi9 ')).toBe('AB10-1Z19');
  });

  it('enforces revocation, expiry, caps, self-invites, age and region', () => {
    const code = createAccessCode({
      type: 'friend_invite',
      campaign: 'founding',
      now: T0,
      maxRedemptions: 1,
      expiresAt: T0 + 7 * DAY,
      regions: ['fr', 'de'],
      issuedBy: 'host',
      random: fixedRandom,
    });
    const request = { userId: 'guest', declaredAge: 25, region: 'FR', now: T0 + DAY };

    expect(code.minAge).toBe(MINIMUM_AGE);
    expect(createAccessCode({ type: 'partner', campaign: 'x', now: T0, maxRedemptions: 5, minAge: 16 }).minAge).toBe(18);

    expect(redeemAccessCode(code, { ...request, declaredAge: 17 })).toEqual({ ok: false, reason: 'age_ineligible' });
    expect(redeemAccessCode(code, { ...request, region: 'US' })).toEqual({ ok: false, reason: 'region_ineligible' });
    expect(redeemAccessCode(code, { ...request, userId: 'host' })).toEqual({ ok: false, reason: 'self_invite' });
    expect(redeemAccessCode(code, { ...request, now: T0 + 8 * DAY })).toEqual({ ok: false, reason: 'expired' });
    expect(redeemAccessCode(revokeAccessCode(code, T0), request)).toEqual({ ok: false, reason: 'revoked' });

    const redeemed = redeemAccessCode(code, request);
    if (!redeemed.ok) throw new Error(redeemed.reason);
    expect(redeemed.campaign).toBe('founding');
    expect(redeemAccessCode(redeemed.code, request)).toEqual({ ok: false, reason: 'already_redeemed' });
    expect(redeemAccessCode(redeemed.code, { ...request, userId: 'other' })).toEqual({ ok: false, reason: 'exhausted' });
  });
});
