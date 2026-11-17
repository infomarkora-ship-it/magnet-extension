# MagnetEngine server

The server behind the MagnetEngine Chrome extension. It receives the people your finder account discovers, lets you review them, drafts messages and replies with Claude Haiku, and hands each sender account its work at a slow, human pace.

It has **no npm dependencies**. It uses only what ships with Node 22, so there is nothing to install and nothing to go out of date.

## What it does
- **Finder ingest and review.** The finder extension sends passing and borderline profiles. Borderline ones are scored by Haiku. You approve or reject each lead on the Review page, with the reasons and Haiku's verdict beside it. Nothing is ever messaged until you approve it.
- **Lead types and sources**, edited in the dashboard per client, and downloaded by the finder. Source scoring shows which sources produce leads you approve, suggests pausing weak ones (or pauses them for you), and suggests rule-out words from the bios you reject.
- **Contact enrichment.** The server reads each lead's bio link and pulls out emails, phone numbers and business links. Bio links come from strangers, so every fetch is guarded against server-side request forgery.
- **Several clients, one finder.** Leads are tagged by client. A person can belong to only one client at a time, so two clients never message the same lead (you can switch this off).
- **Warm-up, caps and pacing** for sender accounts: a gentler start for newer Instagram accounts, a ramping daily limit, sending hours in the client's time zone, and a gap between messages.
- **Account health.** Action blocks put an account to rest for 48 hours and cut its limits. A security check restricts it until you reset it. Finder limits drop automatically after a warning. A "Replace this finder" button sets up a new one with a checklist.
- **Replies.** When someone answers, Haiku drafts a reply from the client's offer. By default you approve each one. Anything it is unsure about, and any "are you a bot?" question, is handed to you.
- **Follow-ups** from a per-client sequence, stopped by any reply.
- **Digest and client report**: leads found, approved, messaged, replied and booked, rejection reasons, best sources, and a copyable text report.

## Deploy on Railway
1. Put this folder in a GitHub repository.
2. In Railway: **New Project > Deploy from GitHub repo**. It builds from the Dockerfile.
3. **Add a Volume** to the service and mount it at `/data`. This is where the database lives. Without it, your data is lost on every deploy.
4. Under **Variables** add:
   | Variable | Needed | Notes |
   |---|---|---|
   | `ADMIN_PASSWORD` | yes | A long passphrase. This is the dashboard login. |
   | `ANTHROPIC_API_KEY` | for Haiku | Without it everything else works, but close calls, openers and reply drafts are not written for you. |
   | `HAIKU_MODEL` | no | Defaults to `claude-haiku-5-5`. |
   | `HAIKU_DAILY_TOKEN_CAP` | no | Defaults to 400000 tokens a day, a spending guard. |
   | `DEFAULT_TZ` | no | Default time zone for new clients. Defaults to `America/New_York`. |
   | `PUBLIC_URL` | no | Only if pairing codes show the wrong address. |
   | `DB_PATH` | no | Already `/data/magnetengine.db` in the Dockerfile. |
5. **Settings > Networking > Generate Domain.** Open it and sign in.
6. Run **one instance only**. The database is SQLite on the volume, so do not add replicas.

## First setup (in the dashboard)
1. **Clients**: add a client with what they offer, their booking link, tone, sending hours and follow-ups.
2. **Finder**: add a lead type (who to look for) and some sources (where to look).
3. **Accounts**: add a **finder** account and a **sender** account for the client. Each shows a pairing code once. In that account's Chrome profile, open the extension, go to Settings, choose the mode (Finder or Sender), paste the code and press Pair.
4. Wait. New accounts only warm up at first. Then leads start arriving on **Review**.

## Running it locally
```
ADMIN_PASSWORD=something-long npm start
```
Open http://localhost:3000. Tests: `npm test` (server and dashboard), and `npm run test:extension` with the extension folder next to this one.

## Security notes
- The dashboard uses a signed, HttpOnly, SameSite=Strict cookie, throttles login attempts, and requires JSON on every change (which blocks cross-site form posts). A strict content security policy blocks inline scripts.
- Pairing tokens are stored hashed. A code is shown once. "New pairing code" invalidates the old one.
- Everything from Instagram (bios, captions, messages) is untrusted. It is shown with `textContent` only, wrapped in tags for Haiku with an instruction to ignore anything inside it, and Haiku's output is cleaned: links other than the client's booking link are removed from replies and openers are link-free.
- Replies are drafts unless you switch on auto-reply for a client, and a handoff from Haiku always goes to a person.

## Honest limits
- The extension and server were tested together against a simulation of Instagram, never against live Instagram. The page readers in the extension are the part most likely to need tuning. Try one location and one profile first.
- The dashboard was tested with a scripted fake page and the real server, not in every browser. Please click through it once.
- SQLite on a single volume is simple and fine for a few clients and thousands of leads. Take Railway volume backups.
- Automated browsing and messaging on Instagram goes against Instagram's rules. Treat finder accounts as replaceable.
