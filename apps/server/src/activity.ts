import { ACTIVITY_TYPES, type ActivityEvent } from '@lifeos/contracts';
import { DESKTOP_COMPANION, normalizeObservation, type NormalizeRejection } from '@lifeos/promethee';
import { z } from 'zod';
import type { AccountService } from './accounts.js';
import { transaction, type Db } from './db.js';
import type { Account } from './model.js';
import { AppError, audit } from './support.js';

const MAX_EVENTS = 2000;
const shortText = z.string().min(1).max(200);

/**
 * The companion's `lifeos.desktop-activity` export. Only the fields that
 * describe the observation are read; ids, evidence tier, confidence and
 * visibility are recomputed here and never taken from the client.
 */
export const DesktopUpload = z.object({
  format: z.literal('lifeos.desktop-activity'),
  version: z.literal(1),
  events: z
    .array(
      z.object({
        sourceEventId: shortText,
        type: z.enum(ACTIVITY_TYPES),
        interval: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
        timeZone: z.string().min(1).max(64),
        metrics: z.object({ activeSeconds: z.number().nonnegative().optional() }).default({}),
        context: z
          .object({
            appCategory: z.string().max(64).optional(),
            taskId: z.string().max(100).optional(),
            tags: z.array(z.string().max(32)).max(20).default([]),
          })
          .default({ tags: [] }),
      }),
    )
    .max(MAX_EVENTS),
});
export type DesktopUpload = z.infer<typeof DesktopUpload>;

export interface IngestResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: readonly { readonly sourceEventId: string; readonly reason: NormalizeRejection }[];
}

export class ActivityService {
  constructor(
    private readonly db: Db,
    private readonly accounts: AccountService,
    private readonly now: () => number,
  ) {}

  /** Re-validates each event server-side and stores it immutably. Idempotent. */
  async ingestDesktop(account: Account, upload: DesktopUpload): Promise<IngestResult> {
    const now = this.now();
    return transaction(this.db, async (tx) => {
      // Uploading needs its own consent on the account, separate from tracking on the Mac.
      const consent = await this.accounts.consentLedger(tx, account.id);
      const events: ActivityEvent[] = [];
      const rejected: { sourceEventId: string; reason: NormalizeRejection }[] = [];
      for (const item of upload.events) {
        const result = normalizeObservation({
          userId: account.id,
          observation: {
            sourceEventId: item.sourceEventId,
            type: item.type,
            interval: item.interval,
            timeZone: item.timeZone,
            metrics: item.metrics,
            context: item.context,
            visibility: account.privacy.defaultActivityVisibility,
          },
          connector: DESKTOP_COMPANION,
          consent,
          receivedAt: now,
        });
        if (result.ok) events.push(result.event);
        else rejected.push({ sourceEventId: item.sourceEventId, reason: result.reason });
      }
      if (rejected.length > 0 && rejected.every((r) => r.reason === 'missing_consent')) {
        throw new AppError(403, 'consent_required', 'Allow desktop activity uploads in your privacy settings first.');
      }

      let accepted = 0;
      for (const event of events) {
        const inserted = await tx.query(
          `INSERT INTO activity_events (id, account_id, type, starts_at, ends_at, received_at, event)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
          [event.id, account.id, event.type, new Date(event.interval.start), new Date(event.interval.end), new Date(now), JSON.stringify(event)],
        );
        accepted += inserted.rowCount ?? 0;
      }
      await audit(tx, now, { kind: 'account', id: account.id }, 'activity.ingested', account.id, {
        connector: DESKTOP_COMPANION.id,
        accepted,
        duplicates: events.length - accepted,
        rejected: rejected.length,
      });
      return { accepted, duplicates: events.length - accepted, rejected };
    });
  }

  async list(accountId: string, from: number, to: number): Promise<ActivityEvent[]> {
    const { rows } = await this.db.query<{ event: ActivityEvent }>(
      `SELECT event FROM activity_events WHERE account_id = $1 AND starts_at >= $2 AND starts_at < $3
       ORDER BY starts_at LIMIT 5000`,
      [accountId, new Date(from), new Date(to)],
    );
    return rows.map((row) => row.event);
  }

  /** Deletes every event that overlaps `[from, to)`. */
  async deleteRange(accountId: string, from: number, to: number): Promise<number> {
    // Anything that overlaps the range goes: deleting errs on the side of privacy.
    const result = await this.db.query('DELETE FROM activity_events WHERE account_id = $1 AND starts_at < $3 AND ends_at > $2', [
      accountId,
      new Date(from),
      new Date(to),
    ]);
    await audit(this.db, this.now(), { kind: 'account', id: accountId }, 'activity.deleted', accountId, { count: result.rowCount });
    return result.rowCount ?? 0;
  }
}
