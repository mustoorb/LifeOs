import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../src/support.js';

/** Delivers real mail to a local SMTP server, as a provider would receive it. */
describe('SmtpMailer', () => {
  const received: { from: string; to: string[]; data: string }[] = [];
  let server: SMTPServer;
  let port: number;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onData(stream, session, callback) {
        let data = '';
        stream.on('data', (chunk) => (data += chunk));
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            data,
          });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('verifies the connection and delivers sign-in mail', async () => {
    const mailer = new SmtpMailer(`smtp://127.0.0.1:${port}`, 'LifeOS <hello@lifeos.test>');
    await expect(mailer.verify()).resolves.toBe(true);
    await mailer.send({ to: 'ada@example.com', subject: 'Your LifeOS sign-in code: 123456', text: 'Your LifeOS sign-in code is 123456.' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: 'hello@lifeos.test', to: ['ada@example.com'] });
    expect(received[0]!.data).toMatch(/Subject: Your LifeOS sign-in code: 123456/);
    expect(received[0]!.data).toMatch(/From: LifeOS <hello@lifeos.test>/);
  });

  it('fails fast when the server is unreachable', async () => {
    await expect(new SmtpMailer('smtp://127.0.0.1:1', 'x@y.z').verify()).rejects.toThrow();
  });
});
