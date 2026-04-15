---
name: add-imap
description: Add a generic IMAP/SMTP email channel to NanoClaw. Works with Zoho, iCloud, Yahoo, Fastmail, mailbox.org, and any provider exposing standard IMAP + SMTP with app-password auth. Use when the user wants the agent to read and reply to email without relying on per-provider OAuth (no Azure/GCP App Registration). Triggers on "add imap", "add email", "setup mail", "add zoho", "add icloud", "add yahoo".
---

# Add IMAP/SMTP Email Channel

Adds a generic IMAP (inbound) + SMTP (outbound) channel to NanoClaw. Works with any mail provider that supports standard IMAP and SMTP with **app-password** authentication — no OAuth, no App Registration, no paid API tier.

Tested: **Zoho Mail**, iCloud, Yahoo Mail, Fastmail, mailbox.org. Will also work with Gmail if you enable 2FA and generate an app password.

## Architecture

```
Sender → user@provider.tld
             ↓ IMAP (poll every 30s, plaintext body via mailparser)
         ImapChannel  (src/channels/imap.ts)
             ↓ onMessage()
         NanoClaw agent  →  SMTP reply with In-Reply-To + References headers
```

- **Single JID** per installation: `imap:inbox`. All inbound mail funnels into one chat.
- **Reply-only sending**: `sendMessage()` replies to the most recently received message (thread-aware via Message-ID). Ad-hoc outbound (mail to a new recipient) would require a future MCP tool.
- **Body cap**: bodies are parsed to plaintext and trimmed to 8 KB before being delivered to the agent — protects against marketing/newsletter bloat.

## Phase 1: Pre-flight

### Check current state

If `src/channels/imap.ts` exists and `imapflow` + `nodemailer` + `mailparser` are installed, the code is already applied — skip to Phase 3.

```bash
ls src/channels/imap.ts 2>/dev/null && echo "IMAP code exists" || echo "Not applied"
```

### Ask the user

AskUserQuestion: **Which email provider?**
- **Zoho Mail Free** — 5 GB, no phone required in most regions, IMAP enabled in Settings
- **iCloud** — free via existing Apple ID, 3 aliases allowed, app password required
- **Yahoo Mail** — free, app password required (Account Security → Generate app password)
- **Fastmail** — paid (3€/mo), IMAP native, very reliable
- **mailbox.org** — paid (1€/mo), privacy-first
- **Other** — any IMAP/SMTP-capable provider

Ask for and collect:
- Email address (full, e.g. `real.cloclo@zohomail.eu`)
- App password (NOT the main account password — a provider-generated per-app password)
- IMAP host / port (default 993 SSL)
- SMTP host / port (default 465 SSL; or 587 STARTTLS)

If the user doesn't know the servers, here are the canonical ones:

| Provider | IMAP host:port | SMTP host:port |
|----------|----------------|----------------|
| Zoho (EU) | `imap.zoho.eu:993` | `smtp.zoho.eu:465` |
| Zoho (global) | `imap.zoho.com:993` | `smtp.zoho.com:465` |
| iCloud | `imap.mail.me.com:993` | `smtp.mail.me.com:587` |
| Yahoo | `imap.mail.yahoo.com:993` | `smtp.mail.yahoo.com:465` |
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:465` |
| mailbox.org | `imap.mailbox.org:993` | `smtp.mailbox.org:465` |
| Gmail | `imap.gmail.com:993` | `smtp.gmail.com:465` |

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `imap` is missing, add it:

```bash
git remote add imap https://github.com/qwibitai/nanoclaw-imap.git
```

(If the upstream repo doesn't exist yet, the code may live on your fork's `skill/imap` branch — merge that one instead.)

### Merge the skill branch

```bash
git fetch imap main
git merge imap/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/imap.ts` (ImapChannel class with self-registration via `registerChannel`)
- `src/channels/imap.test.ts` (16 unit tests)
- `import './imap.js'` in the barrel `src/channels/index.ts`
- `imapflow`, `nodemailer`, `mailparser`, `@types/nodemailer`, `@types/mailparser` in `package.json`
- `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_HOST`, `IMAP_PORT`, `SMTP_HOST`, `SMTP_PORT` in `.env.example`

### Validate

```bash
npm install
npm run build
npx vitest run src/channels/imap.test.ts
```

All 16 tests must pass and build must be clean.

## Phase 3: Provider Setup

### 3a. Enable IMAP on the provider (if needed)

Some providers ship with IMAP **disabled** and error with `NO [ALERT] You are yet to enable IMAP for your account` at LOGIN time. Enable it before going further.

- **Zoho**: https://mail.zoho.eu → Settings → Mail Accounts → **IMAP Access** → Enable
- **iCloud**: implicit (enabled by default when Mail app is enabled on the Apple ID)
- **Yahoo**: Account Info → Account Security → "Allow apps that use less secure sign in" OR (preferred) generate an app password
- **Gmail**: Settings → See all settings → Forwarding and POP/IMAP → **IMAP access** → Enable

### 3b. Generate an app password

**Never use the main account password.** Providers enforce app passwords for IMAP/SMTP on accounts with 2FA, and they're safer (scoped, revocable).

- **Zoho**: Settings → Security → App Passwords → Generate → label "NanoClaw"
- **iCloud**: https://appleid.apple.com → Sign-In and Security → App-Specific Passwords → Generate (requires 2FA on Apple ID)
- **Yahoo**: Account Info → Account Security → Manage app passwords → Generate
- **Gmail**: https://myaccount.google.com/apppasswords (2FA required)
- **Fastmail / mailbox.org**: Settings → Password & Security → App Passwords

### 3c. Configure env

Add to `.env`:

```bash
IMAP_USER=real.cloclo@zohomail.eu
IMAP_PASSWORD=<the-app-password-NOT-the-main-password>
IMAP_HOST=imap.zoho.eu
IMAP_PORT=993
SMTP_HOST=smtp.zoho.eu
SMTP_PORT=465
```

Set restrictive permissions:

```bash
chmod 600 .env
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env && chmod 600 data/env/env
```

## Phase 4: Registration

### Register the inbox as a NanoClaw chat

```bash
npx tsx setup/index.ts --step register \
  --jid "imap:inbox" \
  --name "<your-assistant-name> mail" \
  --trigger "@<your-assistant-name>" \
  --folder "imap_main" \
  --channel imap \
  --no-trigger-required
```

`--no-trigger-required` means every incoming mail triggers the agent (typical for a personal mail channel). Drop that flag if you want the agent to only respond when explicitly addressed in the mail body (e.g. a shared support inbox).

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw    # macOS
# systemctl --user restart nanoclaw                 # Linux
```

## Phase 5: Verify

### Check connection

```bash
grep -E "IMAP" logs/nanoclaw.log | tail -5
```

You should see `Connected to IMAP user=... host=...`.

If you see `NO [ALERT] You are yet to enable IMAP` → go back to step 3a.
If you see `AUTHENTICATIONFAILED` → the app password is wrong or revoked; regenerate.

### Inbound test

Send a mail to your configured address from any other account. Within ≤30s:

```bash
tail -f logs/nanoclaw.log
```

Expected sequence:
```
New messages count=1
Processing messages group="... mail" messageCount=1
Spawning container agent group="... mail"
Agent output: N chars group="... mail"
IMAP reply sent jid="imap:inbox"
```

The sender should receive a threaded reply in their inbox within ~5 seconds of the agent finishing.

### Outbound test (via another channel)

If you have WhatsApp or Slack registered and your IMAP chat is not set as main:

```
In WhatsApp/Slack:
  "@<name> lis mon dernier mail et réponds-lui que je le rappelle demain"
```

Agent reads the mail context from the IMAP chat and sends a reply via SMTP. Sender gets it threaded.

## Limitations

- **Reply-only.** `sendMessage()` always replies to the last received message. No ad-hoc outbound to a new recipient (planned: dedicated MCP tool).
- **Single JID.** All mail goes to `imap:inbox`; no per-thread routing yet.
- **Body cap 8 KB.** Long bodies get truncated with `[...body truncated, N chars dropped]`. Generally fine for prose; may lose signal on very long threads or marketing mails.
- **Polling, not IDLE.** 30-second latency at worst. IDLE was attempted but proved flaky across providers (mailbox selection state, silent socket drops). Polling is more robust.
- **Plaintext only.** The agent receives the text/plain MIME part via mailparser. HTML-only mails are stripped to text. Attachments ignored.
- **No "Send as alias".** Replies come from `IMAP_USER`. To send from an alias (e.g. show `cloclobot_1@proton.me` as sender while using Zoho as backend), configure the alias in your provider's outgoing identities (Zoho allows this in Settings → Mail Accounts → Send Mail As — may require domain ownership).

## Troubleshooting

### `You are yet to enable IMAP for your account`

IMAP is disabled at the provider. See 3a for how to enable. This is the default on Zoho free accounts — easy one-click fix in Settings.

### `Invalid credentials` / `AUTHENTICATIONFAILED`

- You used your **main account password** instead of an app password. Generate one and retry.
- 2FA is not enabled on the account (some providers require it before allowing app passwords).
- The app password was revoked or expired. Regenerate.

### Agent responds "Prompt is too long"

The agent's session accumulated too much context, usually from earlier mails stored before a body-parsing fix, or from a long conversation history.

Clean up:
```bash
# Clear the SDK session files
rm -f data/sessions/imap_main/.claude/projects/-workspace-group/*.jsonl

# Clear stored mail messages
sqlite3 store/messages.db "DELETE FROM messages WHERE chat_jid='imap:inbox'; DELETE FROM sessions WHERE group_folder='imap_main';"

# Clear IMAP state (forces re-fetch baseline; only mails <10min old will be re-delivered)
rm -f store/imap/state.json

# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### No new mails picked up

- Check `Connected to IMAP` in logs — if missing, auth failed or IMAP disabled.
- Check `store/imap/state.json` — `lastSeenUid` should advance as new mails arrive.
- 30s poll interval: wait up to ~45s after sending the test mail.
- Some providers deliver mails to the SPAM folder by default on new accounts — confirm the mail actually landed in INBOX.

### Replies don't land in the sender's inbox

- Check the "Sent" folder of your IMAP account to confirm SMTP succeeded.
- Check `nodemailer` errors in `logs/nanoclaw.log` — common ones: SMTP auth failed (same app password issue), port 465 blocked by ISP (switch to 587 STARTTLS — set `SMTP_PORT=587`).
- Check the sender's spam folder — replies from a brand-new account often land there initially; mark as not-spam to train.

### High body truncation rate

8 KB cap is conservative. If you often receive long legitimate mails (technical threads, newsletters you actually want), raise `MAX_BODY_CHARS` in `src/channels/imap.ts`. Mind the agent's context budget — 64 KB per message is still fine for Claude, but be aware it multiplies session memory consumption.

## Removal

```bash
# Stop the service
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Remove auth state and cached mail
rm -rf store/imap/
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid='imap:inbox'; DELETE FROM messages WHERE chat_jid='imap:inbox'; DELETE FROM chats WHERE jid='imap:inbox';"

# Clear env vars
sed -i '' '/^IMAP_/d;/^SMTP_/d' .env && cp .env data/env/env

# Optional: uninstall the libs
# npm uninstall imapflow nodemailer mailparser @types/nodemailer @types/mailparser

# Restart
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

The app password can also be revoked on the provider side — recommended after removal.
