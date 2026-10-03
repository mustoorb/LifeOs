import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp, createServices } from './http.js';
import { ConsoleMailer } from './support.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const db = createPool(config.databaseUrl);
  const ran = await migrate(db);
  if (ran.length) console.log(`[server] applied migrations ${ran.join(', ')}`);

  const now = () => Date.now();
  const services = createServices({ db, mailer: new ConsoleMailer(), secret: config.secret, now });
  // The web client is built next to the server (apps/web/dist); override with LIFEOS_WEB_DIR.
  const webDir = process.env.LIFEOS_WEB_DIR ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const app = createApp(services, { trustProxy: config.trustProxy, now, secureCookies: config.production, webDir });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[server] listening on http://${info.address}:${info.port}`);
  });

  const shutdown = () => {
    server.close(() => void db.end().then(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `[server] ${error.message}` : error);
  process.exit(1);
});
