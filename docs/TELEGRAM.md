# The Knowing Telegram bot

Share a TikTok to Knowing in one tap: **TikTok → Share → Telegram → your bot**.
The bot downloads the video, looks at 8 frames, transcribes what's said, and
saves exactly what it showed. Later, ask in your own words and it hands back
that drill, setup or plan, plus what you've already told it about yourself.
It's a memory tool, not a coach: no one has to save captions or re-explain anything.

## What it does

| You do | Knowing does |
|---|---|
| Share a TikTok link (or send any video) | Saves exactly what it showed and reacts in a sentence or two: what it is, and how it connects to what you've saved ("Another way to hold Bank: Mira on CCTV instead of lockers"). It doesn't coach |
| Share 3 or more in one scroll | About 15 minutes after the last one, a short wrap-up: what you kept and how it fits with your other saves |
| Tap **Keep both** / **Replace the old one** | Asked only when a new video duplicates an older save. Another way to do something is kept next to the old one, with **Replace the old one** if you want it |
| Tap **Fix something** | Tell it what it got wrong and the save is rewritten |
| Tap **Show steps** / **Start now** | The full steps, or a step-by-step run with **Next** / **Back** that counts each time you finish |
| Ask a question | Answers from the matching saves and names them. If nothing matches exactly, it adapts the closest saves to your situation and says which parts are straight from your videos |
| Mention something lasting ("I'm Gold on PC", "I'm a junior") | Remembers it, so you never repeat it |
| `/memory` | Shows what it remembers about you, with a button to forget each one |
| `/saved` | Lists everything, grouped by topic |

If a video is mostly talking and audio isn't available, the card offers **Add what it says**: paste the caption and the save is rewritten to be exact.

## Cost

Claude Opus (`KNOWING_WATCH_MODEL`) watches each video once, so the details are read right:
about **$0.10 a video**. Claude Haiku (`KNOWING_BOT_MODEL`) answers questions for a fraction
of a cent each. Speech goes through OpenAI's `gpt-4o-mini-transcribe`, and Vercel, Supabase
and Telegram stay on free plans. For one person sharing about 5 videos and asking about 15
questions a day, expect roughly **$15–20 a month**. Set `KNOWING_WATCH_MODEL=claude-haiku-5-5`
to drop that to a few dollars. Use prepaid credits with auto-reload off so it can never
charge more.

## Setup (about 30 minutes, once)

### 1. Make the bot (Telegram, free)

1. In Telegram, open a chat with **@BotFather** and send `/newbot`.
2. Pick a name ("Knowing") and a username ending in `bot`.
3. Copy the **token** it gives you. That's `TELEGRAM_BOT_TOKEN`.
4. Optional but worth it: send `/setuserpic` to give it a profile picture.

### 2. Make the database (Supabase, free plan)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste [`supabase.sql`](supabase.sql), and click **Run**.
3. Under **Project Settings → API**, copy the **Project URL** (`SUPABASE_URL`) and the
   **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`). Keep the service key secret.

### 3. Get the AI keys (prepaid, with limits)

- **Anthropic** ([console.anthropic.com](https://console.anthropic.com)): add $10 of credit,
  turn auto-reload off, create a key. That's `ANTHROPIC_API_KEY`.
- **OpenAI** ([platform.openai.com](https://platform.openai.com)): add $5, turn auto-recharge
  off, create a key. That's `OPENAI_API_KEY`. Optional: without it the bot only looks at frames.

### 4. Deploy (Vercel, free plan)

Add these in Vercel under **Project Settings → Environment Variables**, then redeploy:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Any random string of letters, numbers, `_` or `-` (make one up, 30+ characters) |
| `TELEGRAM_ALLOWED_USERS` | Your Telegram user id (see step 6). Comma-separate to add friends |
| `SUPABASE_URL` | From Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase |
| `ANTHROPIC_API_KEY` | From Anthropic |
| `OPENAI_API_KEY` | From OpenAI (optional) |
| `KNOWING_DAILY_VIDEOS` | Optional. Videos per person per day (default 15) |
| `KNOWING_DAILY_QUESTIONS` | Optional. Questions per person per day (default 50) |
| `KNOWING_OWNER_ID` | Optional. Who gets error alerts (default: the first id in `TELEGRAM_ALLOWED_USERS`) |
| `KNOWING_CRON_SECRET` | For wrap-ups (step 7). Another random string you make up, different from the webhook secret |

### 5. Connect Telegram to your app

Open this link in a browser, with your values filled in:

```
https://<your-app>.vercel.app/api/telegram/setup?key=<TELEGRAM_WEBHOOK_SECRET>
```

It should say `"ok": true` and your bot's name. This points Telegram at your app and fills in the
bot's commands menu (`/saved`, `/memory`, `/help`, `/delete`) and the text people see before they
tap Start. Running it again is harmless.

### 6. Let yourself in

Send your bot any message. Because you're not on the list yet, it replies with your Telegram id.
Put that number in `TELEGRAM_ALLOWED_USERS` in Vercel, redeploy, and send `/start`.

The bot only answers people on that list, so a stranger who finds it can't spend your credits.

### 7. Turn on wrap-ups (optional)

Wrap-ups need something to check every few minutes whether someone stopped scrolling. Supabase
can do that for free. In Supabase, open **SQL Editor**, paste this with your values filled in, and
run it once:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('knowing-wrapups', '*/5 * * * *',
  $$ select net.http_get('https://<your-app>.vercel.app/api/telegram/wrapup?key=<KNOWING_CRON_SECRET>') $$);
```

To turn them off again: `select cron.unschedule('knowing-wrapups');`

## Keeping it safe and cheap

- **Daily limits.** Each person gets `KNOWING_DAILY_VIDEOS` videos and `KNOWING_DAILY_QUESTIONS`
  questions a day (reset at midnight UTC). Failed attempts don't count.
- **Alerts.** When something breaks, the owner gets a Telegram message from the bot saying what
  (at most one every 5 minutes). If the AI credit runs out, users are told the bot is paused, not broken.
- **Delete.** `/delete` wipes a person's saves, search index and memory after they confirm.
- **Already set up before these existed?** Run [`supabase.sql`](supabase.sql) again. It only adds
  what's missing.

## How it works

```
TikTok Share → Telegram → POST /api/telegram (Vercel)
  → answers Telegram right away, then keeps working:
  → TikTok link → video file (lib/bot/tiktok.ts, via a resolver service)
  → ffmpeg: 8 frames + audio (lib/bot/media.ts)
  → speech to text (OpenAI)
  → Claude Haiku turns it into a save (lib/bot/brain.ts, lib/bot/prompts.ts)
  → Supabase (lib/bot/store.ts), plus search chunks with embeddings (lib/bot/rag*.ts)
  → card with buttons back in Telegram (lib/bot/format.ts)
```

All the conversation logic is in [`lib/bot/handle.ts`](../lib/bot/handle.ts). It takes Telegram, the
database, Claude and video processing as parameters, so `tests/bot-handle.test.ts` runs whole
conversations with fakes.

## How search works (RAG)

When you ask something, Knowing doesn't read every save. It searches them first, then gives Claude only what matches:

1. **Every save is split into chunks:** its card (title and steps), its details, and the video's own words
   (transcript and caption) in overlapping pieces of about 900 characters. Each chunk starts with the save's
   title and topic, so a piece of transcript still says what it belongs to.
2. **Hybrid search.** Each question is matched two ways: by **meaning** (embeddings with pgvector, so
   "where does the one-way mirror go" finds your Mira save) and by **exact words** (Postgres full-text, so
   names like "Mira" or "Bank" always hit). The two rankings are merged with reciprocal rank fusion
   (`match_chunks` in `supabase.sql`).
3. **Follow-ups** like "and the other one?" are searched together with your previous message.
4. **Claude gets the top saves plus their best passages verbatim** from the video, so a detail the summary
   dropped is still there.

Embeddings use your `OPENAI_API_KEY` (`text-embedding-3-small`, about $0.02 per million tokens: well under
a cent a month). Without a key, search still works on exact words. `KNOWING_EMBED_URL`, `KNOWING_EMBED_KEY`
and `KNOWING_EMBED_MODEL` point it at another OpenAI-compatible embeddings service (keep 1536 dimensions or
change the column in `supabase.sql`).

## Limits

- **TikTok downloads are the fragile part.** TikTok has no download API, so the bot uses a resolver
  service (tikwm.com's free API by default; set `KNOWING_TIKTOK_RESOLVER` to swap it). When it fails,
  the bot falls back to the post's caption and says so. Sending the video file itself always works.
- **Videos sent as files:** up to 20 MB (Telegram's limit for bots).
- **Search quality depends on what was captured.** If a video's details were only spoken and the audio
  couldn't be transcribed, they aren't in the save. "Add what it says" fixes that.
- **Time:** each update has 60 seconds on Vercel's free plan, which fits TikTok-length videos.
