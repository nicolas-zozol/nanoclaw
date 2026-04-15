import { promises as fs } from 'fs';
import path from 'path';

import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer, { type Transporter } from 'nodemailer';

import { ASSISTANT_NAME } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Generic IMAP/SMTP channel. Works with any provider that supports basic-auth
// IMAP + SMTP (Zoho, iCloud, Yahoo, mailbox.org, Fastmail, ...).
//
// Env vars (all required except SMTP_PORT which defaults to 465):
//   IMAP_USER            — full email address
//   IMAP_PASSWORD        — app-specific password (NOT the main account password)
//   IMAP_HOST            — e.g. imap.zoho.eu
//   IMAP_PORT            — usually 993 (TLS)
//   SMTP_HOST            — e.g. smtp.zoho.eu
//   SMTP_PORT            — usually 465 (SSL) or 587 (STARTTLS)
//
// JID scheme: single inbox per account. All inbound mail → `imap:inbox`.
// Outbound `sendMessage(jid, text)` replies to the most recently received
// message (threaded). Use future dedicated MCP tool for ad-hoc new mails.

const INBOX_JID = 'imap:inbox';

// Where we persist the last seen UID and last replied-to message id.
const STATE_DIR = path.join(process.cwd(), 'store', 'imap');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

// How often we poll the inbox for new mail. 30s keeps latency acceptable
// while staying within every free provider's rate limit (Zoho, iCloud, Yahoo).
// IMAP IDLE would give push delivery but requires careful mailbox-state
// management and misbehaves on some providers; polling is the reliable choice.
const POLL_INTERVAL_MS = 30_000;

// Cap the mail body size we pass to the agent. Marketing/newsletter mails
// can be 100+ KB of HTML; even after mime-parsing to plaintext they stay
// long. 8 KB keeps the agent's prompt tractable without losing substance.
const MAX_BODY_CHARS = 8_000;

interface State {
  lastSeenUid?: number;
  // RFC 822 Message-ID of the most recently received message — used to build
  // In-Reply-To / References headers when the agent replies.
  lastReceivedMessageId?: string;
  // SMTP `To:` address for the reply — the original sender.
  lastReceivedFrom?: string;
  // Subject of the last received message — used to prefix the reply.
  lastReceivedSubject?: string;
}

export interface ImapChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class ImapChannel implements Channel {
  name = 'imap';

  private imap: ImapFlow | null = null;
  private smtp: Transporter;

  private user: string;
  private password: string;
  private imapHost: string;
  private imapPort: number;
  private smtpHost: string;
  private smtpPort: number;

  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private state: State = {};
  private pollTimer: NodeJS.Timeout | null = null;

  private opts: ImapChannelOpts;

  constructor(opts: ImapChannelOpts) {
    this.opts = opts;

    const env = readEnvFile([
      'IMAP_USER',
      'IMAP_PASSWORD',
      'IMAP_HOST',
      'IMAP_PORT',
      'SMTP_HOST',
      'SMTP_PORT',
    ]);

    const required = ['IMAP_USER', 'IMAP_PASSWORD', 'IMAP_HOST'] as const;
    for (const key of required) {
      if (!env[key]) {
        throw new Error(`IMAP channel: ${key} must be set in .env`);
      }
    }

    this.user = env.IMAP_USER;
    this.password = env.IMAP_PASSWORD;
    this.imapHost = env.IMAP_HOST;
    this.imapPort = parseInt(env.IMAP_PORT || '993', 10);
    this.smtpHost = env.SMTP_HOST || env.IMAP_HOST.replace(/^imap/, 'smtp');
    this.smtpPort = parseInt(env.SMTP_PORT || '465', 10);

    this.smtp = nodemailer.createTransport({
      host: this.smtpHost,
      port: this.smtpPort,
      // 465 = SSL on connect; 587 = STARTTLS after HELO.
      secure: this.smtpPort === 465,
      auth: { user: this.user, pass: this.password },
    });
  }

  async connect(): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await this.loadState();

    this.imap = this.buildImapClient();
    await this.imap.connect();

    this.connected = true;
    logger.info({ user: this.user, host: this.imapHost }, 'Connected to IMAP');

    // Expose the inbox for discovery.
    this.opts.onChatMetadata(
      INBOX_JID,
      new Date().toISOString(),
      this.user,
      'imap',
      false,
    );
    updateChatName(INBOX_JID, this.user);

    // Fetch unseen mail accumulated since last run, then start the poll loop.
    await this.fetchNewMessages();
    await this.flushQueue();
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.imap) {
      try {
        await this.imap.logout();
      } catch (err) {
        logger.debug({ err }, 'IMAP logout failed (ignoring)');
      }
      this.imap = null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) {
      throw new Error(`IMAP channel cannot send to ${jid}`);
    }

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'IMAP disconnected, message queued',
      );
      return;
    }

    try {
      await this.sendReply(text);
      logger.info({ jid, length: text.length }, 'IMAP reply sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send IMAP reply, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imap:');
  }

  // --- Internals -----------------------------------------------------------

  private buildImapClient(): ImapFlow {
    const options: ImapFlowOptions = {
      host: this.imapHost,
      port: this.imapPort,
      secure: true,
      auth: { user: this.user, pass: this.password },
      // imapflow logs are noisy; keep them silent by default.
      logger: false,
    };
    return new ImapFlow(options);
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(STATE_PATH, 'utf8');
      this.state = JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err }, 'IMAP: failed to read state');
      }
    }
  }

  private async saveState(): Promise<void> {
    await fs.writeFile(STATE_PATH, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * Fetch everything newer than lastSeenUid from INBOX. First run uses UID 1:*
   * and bootstraps the cursor without replaying history (we mark the max UID
   * found but don't fire onMessage for messages older than "now - 10 min").
   */
  private async fetchNewMessages(): Promise<void> {
    if (!this.imap) return;

    const lock = await this.imap.getMailboxLock('INBOX');
    try {
      const since = this.state.lastSeenUid
        ? `${this.state.lastSeenUid + 1}:*`
        : '1:*';

      let maxUid = this.state.lastSeenUid || 0;
      let isFirstRun = !this.state.lastSeenUid;

      for await (const msg of this.imap.fetch(since, {
        uid: true,
        envelope: true,
        source: true,
        flags: true,
      })) {
        maxUid = Math.max(maxUid, msg.uid);

        // On bootstrap, fast-forward: record the UIDs but only deliver
        // messages received in the last 10 minutes. Otherwise restarting
        // NanoClaw would re-trigger the agent on the whole inbox history.
        if (isFirstRun) {
          const age = Date.now() - (msg.envelope?.date?.getTime() || 0);
          if (age > 10 * 60 * 1000) continue;
        }

        await this.deliverMessage(msg);
      }

      if (maxUid > 0 && maxUid !== this.state.lastSeenUid) {
        this.state.lastSeenUid = maxUid;
        await this.saveState();
      }
    } finally {
      lock.release();
    }
  }

  private async deliverMessage(msg: {
    uid: number;
    envelope?: {
      from?: Array<{ name?: string; address?: string }>;
      subject?: string;
      date?: Date;
      messageId?: string;
    };
    source?: Buffer;
    flags?: Set<string>;
  }): Promise<void> {
    // Metadata fires regardless of registration — allows discovery.
    const ts = msg.envelope?.date?.toISOString() || new Date().toISOString();
    this.opts.onChatMetadata(INBOX_JID, ts, this.user, 'imap', false);

    const groups = this.opts.registeredGroups();
    if (!groups[INBOX_JID]) return;

    const fromAddr = msg.envelope?.from?.[0]?.address || '(unknown)';
    const fromName = msg.envelope?.from?.[0]?.name || fromAddr;
    const subject = msg.envelope?.subject || '(no subject)';

    // Parse MIME properly so we hand the agent clean plaintext — not raw
    // source with boundaries, base64 blobs, or a 50 KB HTML body.
    let body = '';
    if (msg.source) {
      try {
        const parsed = await simpleParser(msg.source);
        // Prefer the text/plain part. If a mail is HTML-only, mailparser
        // strips tags into .text too. Fall back to bodyPreview shape if
        // for some reason nothing landed.
        body = (parsed.text || '').trim();
      } catch (err) {
        logger.warn(
          { err, uid: msg.uid },
          'IMAP: mailparser failed, using empty body',
        );
      }
    }

    if (body.length > MAX_BODY_CHARS) {
      body =
        body.slice(0, MAX_BODY_CHARS) +
        `\n\n[...body truncated, ${body.length - MAX_BODY_CHARS} chars dropped]`;
    }

    const content = `Subject: ${subject}\n\n${body}`;

    const isFromMe = fromAddr.toLowerCase() === this.user.toLowerCase();
    const isBotMessage = content.startsWith(`${ASSISTANT_NAME}:`);

    if (!isFromMe && !isBotMessage) {
      this.state.lastReceivedMessageId = msg.envelope?.messageId;
      this.state.lastReceivedFrom = fromAddr;
      this.state.lastReceivedSubject = subject;
      void this.saveState();
    }

    const newMsg: NewMessage = {
      id: msg.envelope?.messageId || `imap-uid-${msg.uid}`,
      chat_jid: INBOX_JID,
      sender: fromAddr,
      sender_name: fromName,
      content,
      timestamp: ts,
      is_from_me: isFromMe,
      is_bot_message: isBotMessage,
    };

    this.opts.onMessage(INBOX_JID, newMsg);
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (!this.connected || !this.imap) return;
      try {
        await this.fetchNewMessages();
      } catch (err) {
        logger.warn({ err }, 'IMAP poll failed, reconnecting');
        await this.reconnect().catch((err2) =>
          logger.error({ err: err2 }, 'IMAP reconnect failed'),
        );
      }
    }, POLL_INTERVAL_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.imap) {
      try {
        await this.imap.logout();
      } catch {
        // ignored — we're replacing it
      }
    }
    this.imap = this.buildImapClient();
    await this.imap.connect();
    await this.fetchNewMessages();
  }

  /**
   * Send a reply to the last received message. Threads via In-Reply-To +
   * References using the original Message-ID. Subject gets "Re: " prefixed
   * (if not already).
   */
  private async sendReply(text: string): Promise<void> {
    const { lastReceivedFrom, lastReceivedMessageId, lastReceivedSubject } =
      this.state;

    if (!lastReceivedFrom) {
      logger.warn(
        'IMAP: no last-received sender to reply to; dropping outbound. ' +
          'Send a mail via the outbox tool instead.',
      );
      return;
    }

    const subject = (lastReceivedSubject || '').toLowerCase().startsWith('re:')
      ? lastReceivedSubject
      : `Re: ${lastReceivedSubject || ''}`;

    await this.smtp.sendMail({
      from: this.user,
      to: lastReceivedFrom,
      subject,
      text,
      inReplyTo: lastReceivedMessageId,
      references: lastReceivedMessageId,
    });
  }

  private async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendReply(item.text);
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued IMAP reply sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('imap', (opts: ChannelOpts) => {
  const env = readEnvFile(['IMAP_USER', 'IMAP_PASSWORD', 'IMAP_HOST']);
  if (!env.IMAP_USER || !env.IMAP_PASSWORD || !env.IMAP_HOST) {
    logger.warn('IMAP: IMAP_USER, IMAP_PASSWORD or IMAP_HOST not set');
    return null;
  }
  return new ImapChannel(opts);
});
