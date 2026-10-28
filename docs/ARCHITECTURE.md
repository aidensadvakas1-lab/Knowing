# Architecture

Knowing is a single Next.js app: a client-rendered UI and three API routes.
There is no database. Each device keeps its own data in localStorage.

## Data model

Defined in [`lib/types.ts`](../lib/types.ts).

- **Profile**: `now`, `goal`, `skills`, `time`, `more`. Free text.
- **KnowledgeItem**: one taught thing. `kind` (tiktok, video, article, note), `title`, `url`, `content` (transcript or notes, max 20,000 chars), `takeaways`, `tags`, `status`, `createdAt`.
- **ChatTurn**: `role` and `content`. The last 30 turns are kept.

Storage keys are versioned (`knowing.v1.*`) so a future schema change can migrate.
Everything read back from storage is re-validated with the zod schemas, so corrupt
or hand-edited data is dropped item by item instead of crashing the app.

## Request flow

### Teaching (`POST /api/learn`)

1. Body validated by `LearnRequestSchema`: needs a link, content, or both.
2. If no content was pasted, `fetchSource()` picks a strategy from the link:
   - **YouTube** → caption transcript via `youtube-transcript`, title via oEmbed.
   - **TikTok** → caption and author via TikTok's public oEmbed endpoint.
   - **Anything else** → the page's HTML, reduced to its main text by `htmlToText()`.
3. `buildExtractionPrompt()` + the fast model (`claude-haiku-5-5`) with a JSON
   schema output format return a title, takeaways and tags. `cleanExtraction()`
   trims and caps whatever comes back.
4. Every step fails soft: the user always keeps their text, with a short warning.

The client adds the item immediately with status `reading`, then fills it in
when the response arrives, so the list never waits on the network.

### Chatting (`POST /api/chat`)

1. Body validated by `ChatRequestSchema`; the last message must be the user's.
2. The **server** builds the system prompt with `buildSystemPrompt()` from the
   profile and items. The client cannot send its own instructions.
3. Knowledge is added newest first until a 60,000 character budget is used, so a
   large library degrades gracefully instead of overflowing the context window.
4. The answer streams from `claude-opus-5-5` with server-side refusal fallbacks
   enabled. The route re-emits it as newline-delimited JSON events:

   ```
   {"type":"text","text":"## Phase 1"}
   {"type":"text","text":": Foundations"}
   {"type":"done","stopReason":"end_turn"}
   ```

   An error after streaming has started is sent as `{"type":"error",...}`, so the
   client can keep the partial answer and still show what went wrong.

### Health (`GET /api/health`)

Reports whether an API key is configured and whether a password is required.
The UI uses it to show a setup banner or the password prompt.

## Security

- `ANTHROPIC_API_KEY` is read only in `lib/server.ts`, which imports
  `server-only` so it can never be bundled for the browser.
- `APP_PASSWORD`, when set, is checked with a constant-time comparison on every
  AI route.
- Link fetching refuses private, loopback, link-local and cloud-metadata
  addresses, checks again after redirects, and stops reading after 2 MB or 10 s.
- Model output is rendered by `renderMarkdown()`, which escapes all HTML first
  and only links `http(s)` URLs.

## Testing

`tests/` covers every pure module: prompt building, Markdown rendering, link
parsing and SSRF guards, request validation, HTML-to-text, the stream parser,
and storage including backup and restore. Run `npm test`.
