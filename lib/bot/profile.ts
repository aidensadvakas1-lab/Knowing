/**
 * How the bot presents itself in Telegram: the commands menu, the profile
 * text, and the first message. Set once with GET /api/telegram/setup.
 */

/** Shown in the menu button next to the message box. */
export const COMMANDS = [
  { command: "saved", description: "Everything you've saved" },
  { command: "memory", description: "What I remember about you" },
  { command: "help", description: "How to send me videos" },
  { command: "delete", description: "Delete all your data" },
] as const;

/** Shown on the empty chat before someone taps Start (max 512 characters). */
export const DESCRIPTION =
  "Send me TikToks you want to keep: drills, game setups, study methods, ideas. I watch and listen to each one and remember exactly what it showed. Later, ask in your own words and get that exact thing back.";

/** Shown on the bot's profile and in shares (max 120 characters). */
export const SHORT_DESCRIPTION = "Remembers the videos you send it, so you can ask about them later.";

export const WELCOME = `Send me videos you want to keep. In TikTok, tap Share, then Telegram, then me.

I'll remember exactly what each one showed. Ask me about any of them later, in your own words.

/saved lists everything. /memory shows what I remember about you. /delete wipes it all.`;
