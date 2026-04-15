import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Cloclo',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// In-memory fs — prevents hitting the real disk during tests.
const memFsRef = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (p: string) => {
      if (memFsRef.map.has(p)) return memFsRef.map.get(p)!;
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    writeFile: vi.fn(async (p: string, data: string) => {
      memFsRef.map.set(p, data);
    }),
  },
}));

// --- imapflow mock ---

const imapRef = vi.hoisted(() => ({
  fetched: [] as any[],
  idleNeverReturns: false,
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(public options: any) {}
    async connect() {}
    async logout() {}
    async getMailboxLock() {
      return { release: () => undefined };
    }
    async *fetch(_query: string, _opts: any) {
      for (const m of imapRef.fetched) yield m;
    }
    async idle() {
      if (imapRef.idleNeverReturns) {
        // Hang forever — simulates real IDLE that doesn't return until notification.
        return new Promise<void>(() => {});
      }
      // Otherwise return immediately (acts like a no-op for tests).
    }
  },
}));

// --- nodemailer mock ---

const sendMailMock = vi.fn(async () => ({ messageId: 'sent-1' }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: sendMailMock,
    })),
  },
}));

// --- env mock ---

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    IMAP_USER: 'real.cloclo@zohomail.eu',
    IMAP_PASSWORD: 'app-pw',
    IMAP_HOST: 'imap.zoho.eu',
    IMAP_PORT: '993',
    SMTP_HOST: 'smtp.zoho.eu',
    SMTP_PORT: '465',
  }),
}));

import { ImapChannel, ImapChannelOpts } from './imap.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<ImapChannelOpts>): ImapChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'imap:inbox': {
        name: 'cloclo inbox',
        folder: 'imap_main',
        trigger: '@cloclo',
        added_at: '2026-04-15T00:00:00Z',
        requiresTrigger: false,
        isMain: true,
      },
    })),
    ...overrides,
  };
}

function fetchRow(overrides: Partial<any> = {}) {
  return {
    uid: 42,
    envelope: {
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      subject: 'Hello cloclo',
      date: new Date(), // now — within the 10-min bootstrap window
      messageId: '<msg-abc@example.com>',
    },
    source: Buffer.from(
      'From: Alice <alice@example.com>\r\n' +
        'Subject: Hello cloclo\r\n' +
        'Content-Type: text/plain\r\n' +
        '\r\n' +
        'body of the email',
    ),
    flags: new Set<string>(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMailMock.mockClear();
  imapRef.fetched = [];
  imapRef.idleNeverReturns = true; // default: IDLE doesn't return during test lifetime
  memFsRef.map.clear();
});

// --- Tests ---

describe('ImapChannel constructor', () => {
  it('throws when IMAP_USER is missing', () => {
    (readEnvFile as any).mockReturnValueOnce({
      IMAP_PASSWORD: 'x',
      IMAP_HOST: 'h',
    });
    expect(() => new ImapChannel(createTestOpts())).toThrow(/IMAP_USER/);
  });

  it('throws when IMAP_PASSWORD is missing', () => {
    (readEnvFile as any).mockReturnValueOnce({
      IMAP_USER: 'u',
      IMAP_HOST: 'h',
    });
    expect(() => new ImapChannel(createTestOpts())).toThrow(/IMAP_PASSWORD/);
  });

  it('throws when IMAP_HOST is missing', () => {
    (readEnvFile as any).mockReturnValueOnce({
      IMAP_USER: 'u',
      IMAP_PASSWORD: 'p',
    });
    expect(() => new ImapChannel(createTestOpts())).toThrow(/IMAP_HOST/);
  });

  it('derives SMTP_HOST from IMAP_HOST when unset', () => {
    (readEnvFile as any).mockReturnValueOnce({
      IMAP_USER: 'u@example.com',
      IMAP_PASSWORD: 'pw',
      IMAP_HOST: 'imap.example.com',
    });
    const channel = new ImapChannel(createTestOpts());
    expect((channel as any).smtpHost).toBe('smtp.example.com');
  });
});

describe('ImapChannel connect', () => {
  it('connects, registers inbox metadata, and updates chat name', async () => {
    const opts = createTestOpts();
    const channel = new ImapChannel(opts);
    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'imap:inbox',
      expect.any(String),
      'real.cloclo@zohomail.eu',
      'imap',
      false,
    );
    expect(updateChatName).toHaveBeenCalledWith(
      'imap:inbox',
      'real.cloclo@zohomail.eu',
    );

    await channel.disconnect();
  });

  it('fetches new mail on startup and delivers it', async () => {
    imapRef.fetched = [fetchRow()];

    const opts = createTestOpts();
    const channel = new ImapChannel(opts);
    await channel.connect();

    expect(opts.onMessage).toHaveBeenCalledWith(
      'imap:inbox',
      expect.objectContaining({
        chat_jid: 'imap:inbox',
        sender: 'alice@example.com',
        sender_name: 'Alice',
        content: expect.stringContaining('Subject: Hello cloclo'),
        is_from_me: false,
        is_bot_message: false,
      }),
    );

    await channel.disconnect();
  });

  it('skips delivery when the inbox is not registered', async () => {
    imapRef.fetched = [fetchRow()];
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({})),
    });
    const channel = new ImapChannel(opts);
    await channel.connect();
    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('marks mail from own address as is_from_me', async () => {
    imapRef.fetched = [
      fetchRow({
        envelope: {
          from: [{ address: 'real.cloclo@zohomail.eu', name: 'Me' }],
          subject: 's',
          date: new Date(),
          messageId: '<x@y>',
        },
      }),
    ];
    const opts = createTestOpts();
    const channel = new ImapChannel(opts);
    await channel.connect();
    const delivered = (opts.onMessage as any).mock.calls[0][1];
    expect(delivered.is_from_me).toBe(true);
    await channel.disconnect();
  });

  it('persists lastSeenUid so subsequent restarts skip old mail', async () => {
    imapRef.fetched = [fetchRow({ uid: 100 }), fetchRow({ uid: 101 })];
    const channel = new ImapChannel(createTestOpts());
    await channel.connect();
    // State file should now contain lastSeenUid=101
    const stateRaw = memFsRef.map.get(
      (await import('path')).default.join(
        process.cwd(),
        'store',
        'imap',
        'state.json',
      ),
    );
    expect(stateRaw).toBeDefined();
    const state = JSON.parse(stateRaw!);
    expect(state.lastSeenUid).toBe(101);
    await channel.disconnect();
  });

  it('does not replay old history on first boot (> 10 min)', async () => {
    const oldDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago
    imapRef.fetched = [
      fetchRow({
        uid: 50,
        envelope: {
          from: [{ address: 'alice@example.com' }],
          subject: 'old',
          date: oldDate,
          messageId: '<old@x>',
        },
      }),
    ];
    const opts = createTestOpts();
    const channel = new ImapChannel(opts);
    await channel.connect();
    // Bootstrap should have skipped the old message.
    expect(opts.onMessage).not.toHaveBeenCalled();
    await channel.disconnect();
  });
});

describe('ImapChannel sendMessage', () => {
  it('replies to the last received sender with Re: subject', async () => {
    imapRef.fetched = [fetchRow()];
    const channel = new ImapChannel(createTestOpts());
    await channel.connect();

    await channel.sendMessage('imap:inbox', 'thanks for the ping');

    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'real.cloclo@zohomail.eu',
        to: 'alice@example.com',
        subject: 'Re: Hello cloclo',
        text: 'thanks for the ping',
        inReplyTo: '<msg-abc@example.com>',
        references: '<msg-abc@example.com>',
      }),
    );

    await channel.disconnect();
  });

  it('drops outbound when no last-received is tracked', async () => {
    // No inbound — state has no lastReceivedFrom.
    const channel = new ImapChannel(createTestOpts());
    await channel.connect();
    await channel.sendMessage('imap:inbox', 'hello');
    expect(sendMailMock).not.toHaveBeenCalled();
    await channel.disconnect();
  });

  it('keeps existing Re: prefix rather than stacking', async () => {
    imapRef.fetched = [
      fetchRow({
        envelope: {
          from: [{ address: 'alice@example.com' }],
          subject: 'Re: already a reply',
          date: new Date(),
          messageId: '<m@x>',
        },
      }),
    ];
    const channel = new ImapChannel(createTestOpts());
    await channel.connect();
    await channel.sendMessage('imap:inbox', 'ok');
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Re: already a reply' }),
    );
    await channel.disconnect();
  });

  it('rejects sends to foreign JIDs', async () => {
    const channel = new ImapChannel(createTestOpts());
    await channel.connect();
    await expect(channel.sendMessage('slack:x', 'y')).rejects.toThrow(
      /cannot send/,
    );
    await channel.disconnect();
  });

  it('queues outbound when disconnected', async () => {
    const channel = new ImapChannel(createTestOpts());
    await channel.sendMessage('imap:inbox', 'queued');
    expect((channel as any).outgoingQueue.length).toBe(1);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe('ImapChannel ownsJid', () => {
  it('owns only imap:*', () => {
    const channel = new ImapChannel(createTestOpts());
    expect(channel.ownsJid('imap:inbox')).toBe(true);
    expect(channel.ownsJid('imap:whatever')).toBe(true);
    expect(channel.ownsJid('slack:C123')).toBe(false);
    expect(channel.ownsJid('outlook:inbox')).toBe(false);
  });
});
