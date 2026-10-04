import type { ActivityEvent, Instant } from '@lifeos/contracts';
import {
  DESKTOP_COMPANION,
  desktopSessionToObservation,
  normalizeObservation,
  type ConsentLedger,
  type DesktopSession,
} from '@lifeos/promethee';

/**
 * What may leave the Mac: derived sessions only, normalized into canonical
 * ActivityEvents. App bundle ids, app names and raw samples never appear.
 * Until the account service exists, this is a file the user saves themselves.
 */
export interface DesktopExport {
  readonly format: 'lifeos.desktop-activity';
  readonly version: 1;
  readonly generatedAt: Instant;
  readonly timeZone: string;
  readonly connector: string;
  readonly events: readonly ActivityEvent[];
  readonly rejected: readonly { readonly sourceEventId: string; readonly reason: string }[];
}

export function buildExport(input: {
  sessions: readonly DesktopSession[];
  timeZone: string;
  consent: ConsentLedger;
  userId: string;
  now: Instant;
}): DesktopExport {
  const events: ActivityEvent[] = [];
  const rejected: { sourceEventId: string; reason: string }[] = [];
  for (const session of input.sessions) {
    const observation = desktopSessionToObservation(session, input.timeZone);
    const result = normalizeObservation({
      userId: input.userId,
      observation,
      connector: DESKTOP_COMPANION,
      consent: input.consent,
      receivedAt: input.now,
    });
    if (result.ok) events.push(result.event);
    else rejected.push({ sourceEventId: observation.sourceEventId, reason: result.reason });
  }
  return {
    format: 'lifeos.desktop-activity',
    version: 1,
    generatedAt: input.now,
    timeZone: input.timeZone,
    connector: DESKTOP_COMPANION.id,
    events,
    rejected,
  };
}
