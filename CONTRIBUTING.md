# Contributing

## Setup

```bash
nvm use            # Node 22
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
npm run dev        # http://localhost:3000
```

## Before you open a pull request

```bash
npm run check      # typecheck + unit tests + production build
```

CI runs the same command on every pull request.

## Conventions

- **Types first.** Shared shapes live in `lib/types.ts`; request bodies are validated with the zod schemas in `lib/validate.ts`.
- **Pure logic in `lib/`, UI in `components/`.** Anything in `lib/` without `server-only` should be testable in Node with no browser.
- **Every new function in `lib/` gets a test** in `tests/`.
- **Server-only code** (API keys, outbound fetches) imports `"server-only"` so it can never end up in the browser bundle.
- **Fail soft.** If fetching a link or the AI step fails, keep what the user typed and show a short message.
- **Mobile first.** Check every UI change at 390px wide and on desktop.
