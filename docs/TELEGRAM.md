# The Knowing Telegram bot

Share a TikTok to Knowing in one tap: **TikTok → Share → Telegram → your bot**.
The bot downloads the video, looks at 8 frames, transcribes what's said, and
saves exactly what it showed. Later, ask in your own words and it hands back
that drill, setup or plan, plus what you've already told it about yourself.
It's a memory tool, not a coach: no one has to save captions or re-explain anything.

## What it does

| You do | Knowing does |
|---|---|
| Share a TikTok link (or send any video) | Saves exactly what it showed and reacts in a sentence or two: what it is, and how it connects to what you've saved ("This one puts Mira on CCTV, not lockers like your last Bank save"). It doesn't coach |
| Tap **Keep both** / **Replace the old one** | Shown only when a new video conflicts with or duplicates an older save |
| Tap **Show steps** / **Start now** | The full steps, or a step-by-step run with **Next** / **Back** that counts each time you finish |
| Ask a question | Answers from the matching saves and names them. If your save is for a different map or skill, it says so |
| Mention something lasting ("I'm Gold on PC", "I'm a junior") | Remembers it, so you never repeat it |
| `/memory` | Shows what it remembers about you, with a button to forget each one |
| `/saved` | Lists everything, grouped by topic |

If a video is mostly talking and audio isn't available, the card offers **Add what it says**: paste the caption and the save is rewritten to be exact.

## Cost

Built to stay cheap: Claude Haiku (`KNOWING_BOT_MODEL`) for watching and answering, OpenAI's
`gpt-4o-mini-transcribe` for speech, and free plans for Vercel, Supabase and Telegram.
For one person sharing about 5 videos and asking about 15 questions a day, expect roughly
**$2–5 a month**. Use prepaid credits with auto-reload off so it can never charge more.

## Setup (about 30 minutes, once)

### 1. Make the bot (Telegram, free)

1. In Telegram, open a chat with **@BotFather** and send `/newbot`.
2. Pick a name ("Knowing") and a username ending in `bot`.
3. Copy the **token** it gives you. That's `TELEGRAM_BOT_TOKEN`.

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

### 5. Point Telegram at your app

Open this link in a browser, with your values filled in:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

It should say `"Webhook was set"`.

### 6. Let yourself in

Send your bot any message. Because you're not on the list yet, it replies with your Telegram id.
Put that number in `TELEGRAM_ALLOWED_USERS` in Vercel, redeploy, and send `/start`.

The bot only answers people on that list, so a stranger who finds it can't spend your credits.

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
