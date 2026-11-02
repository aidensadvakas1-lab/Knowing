# The Knowing Telegram bot

Share a TikTok to Knowing in one tap: **TikTok → Share → Telegram → your bot**.
The bot downloads the video, looks at 20 frames, transcribes what's said, and
saves exactly what it showed. Later, ask in your own words and it hands back
that drill, setup or plan, plus what you've already told it about yourself.
It's a memory and a companion, not a coach: it keeps every video and every chat, so no one has to
save captions or repeat themselves, and you can talk to it about anything.

## What it does

| You do | Knowing does |
|---|---|
| Share a TikTok link (or send any video) | Saves exactly what it showed and reacts in a sentence or two: what it is, and how it connects to what you've saved ("Another way to hold Bank: Mira on CCTV instead of lockers"). It doesn't coach |
| Share 3 or more in one scroll | About 15 minutes after the last one, a short wrap-up: what you kept and how it fits with your other saves |
| Tap **Keep both** / **Replace the old one** | Asked only when a new video duplicates an older save. Another way to do something is kept next to the old one, with **Replace the old one** if you want it |
| Tap **Fix something** | Tell it what it got wrong and the save is rewritten |
| Tap **Show steps** / **Start now** | The full steps, or a step-by-step run with **Next** / **Back** that counts each time you finish |
| Ask a question | Answers from the matching saves and names them, each linked to its video (ask "send me the link to that video" and it's right there). If nothing matches exactly, it adapts the closest saves to your situation and says which parts are straight from your videos |
| Just talk (about a video, a car, your game, your day) | Chats like a friend who knows a lot. It can tell you about what's in a video even when the video doesn't say ("that's Clubhouse"), marked as its own read |
| Mention something about you ("I'm Gold on PC", "I love Ferraris") | Remembers it, so you never repeat it. Every chat is also kept and searchable, so "what did I tell you about my tryout?" works weeks later |
| `/memory` | Shows what it remembers about you, with a button to forget each one |
| `/saved` | Lists everything, grouped by topic, each linked to its video |
| `/usage` (or ask "how many questions do I have left?") | Shows the free videos and questions left today, when they reset, and any extras you bought. Checking never uses up a question |

If a video is mostly talking and audio isn't available, the card offers **Add what it says**: paste the caption and the save is rewritten to be exact.

## Cost

Claude Sonnet (`KNOWING_WATCH_MODEL`) watches each video once, so the details are read right:
about **5–8 cents a video**. Before that, Claude Haiku (`KNOWING_READ_MODEL`) copies the text on
screen from frames about a second apart, so a command or link that flashes by isn't missed: about
**half a cent more**. Claude Sonnet (`KNOWING_BOT_MODEL`) also answers and chats, thinking at medium
effort so it can troubleshoot a tutorial step by step: about **2–3 cents a message**, and up to about
5 cents when it has to work through an error. Speech goes through OpenAI's `gpt-4o-mini-transcribe`,
and Vercel, Supabase and Telegram stay on free plans. At the default daily limits of 5 videos and
10 questions, one person can spend at most about **$20 a month**. Setting `KNOWING_BOT_EFFORT=low`
brings answers back to about 2 cents. The daily limits below cap what any one person can spend.

To change how videos are watched, set `KNOWING_WATCH_MODEL` in Vercel and redeploy:

| Value | Per video | Reading |
|---|---|---|
| `claude-haiku-5-5` | under 1 cent | Fine for clear, talky videos |
| `claude-sonnet-5-5` (default) | about 5–8 cents | Strong at reading positions and surfaces |
| `claude-opus-5-5` | about 10–15 cents | The strongest, at about twice Sonnet's cost |

To change who answers, set `KNOWING_BOT_MODEL` the same way:

| Value | Per message | Answers |
|---|---|---|
| `claude-haiku-5-5` | about a tenth of a cent | Fine for simple recall, but knows less and makes more mistakes |
| `claude-sonnet-5-5` (default) | about 2–3 cents | Knows the topic and gets details right |

Use prepaid credits with auto-reload off so it can never charge more.

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
| `TELEGRAM_ALLOWED_USERS` | Your Telegram user id (see step 6). Comma-separate to add more people by hand |
| `SUPABASE_URL` | From Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase |
| `ANTHROPIC_API_KEY` | From Anthropic |
| `OPENAI_API_KEY` | From OpenAI (optional) |
| `KNOWING_DAILY_VIDEOS` | Optional. Videos per person per day (default 5) |
| `KNOWING_DAILY_QUESTIONS` | Optional. Questions per person per day (default 10) |
| `KNOWING_OWNER_ID` | Optional. Who gets error alerts, join notices and `/invite` (default: the first id in `TELEGRAM_ALLOWED_USERS`) |
| `KNOWING_INVITE_SPOTS` | Optional. How many people can join with the invite link (default 10) |
| `KNOWING_INVITE_CODE` | Optional. Your own code for the invite link, 6 to 64 letters, numbers, `_` or `-`. Change it to stop an old link working |
| `KNOWING_PACK_STARS` | Optional. Price in Telegram Stars of 10 extra videos or 20 extra questions (default 100, about $2 to the buyer). `0` turns buying off |
| `KNOWING_CRON_SECRET` | For wrap-ups (step 7). Another random string you make up, different from the webhook secret |

### 5. Connect Telegram to your app

Open this link in a browser, with your values filled in:

```
https://<your-app>.vercel.app/api/telegram/setup?key=<TELEGRAM_WEBHOOK_SECRET>
```

It should say `"ok": true` and your bot's name. This points Telegram at your app and fills in the
bot's commands menu (`/saved`, `/memory`, `/usage`, `/help`, `/delete`, `/support`) and the text people see
before they tap Start. Running it again is harmless, and it's needed once after updates that change
what Telegram sends the bot (like payments).

### 6. Let yourself in

Send your bot any message. Because you're not on the list yet, it replies with your Telegram id.
Put that number in `TELEGRAM_ALLOWED_USERS` in Vercel, redeploy, and send `/start`.

The bot only answers people on that list or people who joined with your invite link, so a stranger
who finds it can't spend your credits.

### Invite people (no settings needed)

Send your bot `/invite`. It replies with your invite link and how many spots are used. Share the
link: anyone who opens it and taps Start is in, until the spots run out (10 by default, set
`KNOWING_INVITE_SPOTS` for more). The bot messages you each time someone joins, and when someone
is turned away because it's full. People added in `TELEGRAM_ALLOWED_USERS` don't use a spot.

The link's code comes from your webhook secret, so it can't be guessed. If it spreads further than
you wanted, set `KNOWING_INVITE_CODE` to a new code and redeploy: the old link stops working, and
people who already joined stay in.

### Sell extra videos and questions (Telegram Stars)

When someone uses up their free videos or questions for the day, the limit message offers a pack:
**10 more videos** or **20 more questions** for `KNOWING_PACK_STARS` Stars (default 100, which costs
the buyer about $2). They pay inside Telegram. Extras never expire and are used only after the free
daily amount runs out. Telegram requires Stars for digital goods sold in bots
([rules](https://core.telegram.org/bots/payments-stars)).

To turn it on after updating:

1. Run [`supabase.sql`](supabase.sql) again. It adds the `wallet` column that holds what people
   bought. Until it's there, checkouts are refused, so nobody is charged for nothing.
2. Open the setup link from step 5 again, so Telegram starts sending payment checks to the bot.
3. Turn on two-step verification for your own Telegram account (Telegram requires it to sell).

What you get: the bot messages you about each payment, with a ready-to-send refund command. `/refund user_id
payment_id` gives the Stars back and removes the pack. People can send `/support` or `/paysupport`
with a message, which reaches you with their id; answer with `/reply user_id your message`. `/terms`
shows the terms Telegram asks for.

Getting the money out: Stars collect in the bot's balance. Third-party write-ups put the payout at
about 1.3 cents a Star after the app stores and Telegram take their share, withdrawable from 1,000
Stars, 21 days after they were earned, as TON (a cryptocurrency) through Fragment. Check the current
terms in Telegram before counting on it.

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
  questions a day (5 and 10 by default, reset at midnight UTC). Failed attempts don't count.
- **Alerts.** When something breaks, the owner gets a Telegram message from the bot saying what
  (at most one every 5 minutes). If the AI credit runs out, users are told the bot is paused, not broken.
- **Delete.** `/delete` wipes a person's saves, chats, search index and memory after they confirm.
- **Already set up before these existed?** Run [`supabase.sql`](supabase.sql) again. It only adds
  what's missing.

## How it works

```
TikTok Share → Telegram → POST /api/telegram (Vercel)
  → answers Telegram right away, then keeps working:
  → TikTok link → video file (lib/bot/tiktok.ts, via a resolver service)
  → ffmpeg: 20 frames + audio (lib/bot/media.ts)
  → speech to text (OpenAI)
  → Claude (Sonnet by default) turns it into a save (lib/bot/brain.ts, lib/bot/prompts.ts)
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
3. **Follow-ups** like "and the other one?" are searched together with your previous message. A video you
   just shared counts as your previous message, so "how fast is it?" finds it.
4. **Claude gets the top saves plus their best passages verbatim** from the video, so a detail the summary
   dropped is still there.
5. **Chats are searched the same way.** Every message and its answer goes into `chat_memories`, and each new
   message pulls up to 4 older chats that match (`match_memories` in `supabase.sql`). The last 16 turns are
   always included as they are.

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
