import { parseArgs } from 'node:util';
import { AdminService } from './admin.js';
import { createPool, migrate } from './db.js';
import { AppError, type Actor } from './support.js';

const USAGE = `lifeos-server admin CLI (needs DATABASE_URL)

  migrate
  issue-codes   --campaign <id> --count <n> [--max-redemptions 1] [--type founding|partner|staff|recovery]
                [--expires-days <n>] [--min-age 18] [--regions FR,DE]
  list-codes    [--campaign <id>]
  revoke-code   <code>
  create-season --id <id> --name <name> --starts <YYYY-MM-DD> --weeks <6-12> --campaigns <a,b> [--ruleset xp-v1]
  set-role      <email> <member|admin>
  audit         [--limit 50]
`;

const DAY = 24 * 60 * 60_000;
const CLI: Actor = { kind: 'cli' };

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      campaign: { type: 'string' },
      count: { type: 'string' },
      'max-redemptions': { type: 'string' },
      type: { type: 'string' },
      'expires-days': { type: 'string' },
      'min-age': { type: 'string' },
      regions: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      starts: { type: 'string' },
      weeks: { type: 'string' },
      campaigns: { type: 'string' },
      ruleset: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const db = createPool(databaseUrl);
  const admin = new AdminService(db, Date.now);
  const int = (value: string | undefined, fallback?: number) => {
    if (value === undefined && fallback !== undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`Expected a whole number, got "${value}"`);
    return parsed;
  };
  try {
    await migrate(db);
    switch (command) {
      case 'migrate':
        console.log('Database is up to date.');
        break;
      case 'issue-codes': {
        const type = (values.type ?? 'founding') as 'founding' | 'partner' | 'staff' | 'recovery';
        if (!['founding', 'partner', 'staff', 'recovery'].includes(type)) throw new Error(`Unknown code type "${type}"`);
        const days = values['expires-days'] === undefined ? undefined : int(values['expires-days']);
        const codes = await admin.issueCodes(CLI, {
          type,
          campaign: required(values.campaign, '--campaign'),
          count: int(values.count),
          maxRedemptions: int(values['max-redemptions'], 1),
          ...(days !== undefined ? { expiresAt: Date.now() + days * DAY } : {}),
          ...(values['min-age'] ? { minAge: int(values['min-age']) } : {}),
          ...(values.regions ? { regions: values.regions.split(',').map((r) => r.trim().toUpperCase()) } : {}),
        });
        for (const code of codes) console.log(code.code);
        break;
      }
      case 'list-codes':
        console.table(
          (await admin.listCodes(values.campaign)).map((code) => ({
            code: code.code,
            type: code.type,
            campaign: code.campaign,
            used: `${code.redemptions}/${code.maxRedemptions}`,
            expires: code.expiresAt ? new Date(code.expiresAt).toISOString().slice(0, 10) : '',
            revoked: code.revokedAt ? 'yes' : '',
          })),
        );
        break;
      case 'revoke-code':
        console.log(await admin.revokeCode(CLI, required(positionals[0], '<code>')));
        break;
      case 'create-season': {
        const startsAt = Date.parse(`${required(values.starts, '--starts')}T00:00:00Z`);
        if (Number.isNaN(startsAt)) throw new Error('--starts must be YYYY-MM-DD');
        const season = await admin.createSeason(CLI, {
          id: required(values.id, '--id'),
          name: required(values.name, '--name'),
          startsAt,
          endsAt: startsAt + int(values.weeks) * 7 * DAY,
          campaigns: required(values.campaigns, '--campaigns').split(',').map((c) => c.trim()),
          xpRulesetVersion: values.ruleset ?? 'xp-v1',
        });
        console.log(`Created season ${season.id}: ${new Date(season.window.start).toISOString()} → ${new Date(season.window.end).toISOString()}`);
        break;
      }
      case 'set-role': {
        const role = required(positionals[1], '<role>');
        if (role !== 'admin' && role !== 'member') throw new Error('Role must be admin or member');
        await admin.setRole(CLI, required(positionals[0], '<email>'), role);
        console.log('Role updated.');
        break;
      }
      case 'audit':
        console.table(
          (await admin.auditLog(int(values.limit, 50))).map((entry) => ({
            at: new Date(entry.at).toISOString(),
            actor: entry.actor,
            action: entry.action,
            target: entry.target ?? '',
          })),
        );
        break;
      default:
        throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
    }
  } finally {
    await db.end();
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof AppError || error instanceof Error ? error.message : error);
  process.exit(1);
});
