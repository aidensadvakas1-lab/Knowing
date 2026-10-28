# Security

- The Anthropic API key lives only on the server (`ANTHROPIC_API_KEY`). The browser never sees it.
- Set `APP_PASSWORD` on any public deployment so strangers can't spend your API credits.
- Links the user teaches are fetched server-side. Private and internal addresses (localhost, 10.x, 192.168.x, cloud metadata, and similar) are refused, including after redirects.
- Model output is rendered through a small escaping Markdown renderer (`lib/markdown.ts`); raw HTML from the model is never inserted.
- Profile, items and chat are stored in the browser's localStorage on each device. Nothing is stored on the server.

To report a problem, open a private security advisory on this repository.
