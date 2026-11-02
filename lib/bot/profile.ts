/**
 * How the bot presents itself in Telegram: the commands menu, the profile
 * text, and the first message. Set once with GET /api/telegram/setup.
 */

/** Shown in the menu button next to the message box. */
export const COMMANDS = [
  { command: "help", description: "How everything works" },
  { command: "folders", description: "Your videos by topic" },
  { command: "saved", description: "Everything you've saved" },
  { command: "digest", description: "Weekly flashback on or off" },
  { command: "memory", description: "What I remember about you" },
  { command: "usage", description: "What you have left" },
  { command: "buy", description: "Get more videos or questions" },
  { command: "invite", description: "Invite friends, earn free videos" },
  { command: "instagram", description: "Save Reels straight from Instagram" },
  { command: "delete", description: "Delete all your data" },
  { command: "support", description: "Ask the owner for help" },
] as const;

/** Shown on the empty chat before someone taps Start (max 512 characters). */
export const DESCRIPTION =
  "Send me videos you want to keep: recipes, workouts, game setups, how-tos, ideas. I watch and listen to each one and remember exactly what it showed. Later, ask in your own words, by text or voice, and get that exact thing back, with the moment it happens.";

/** Shown on the bot's profile and in shares (max 120 characters). */
export const SHORT_DESCRIPTION = "Remembers the videos you send it, so you can ask about them later.";

/** The first message, kept short. The guide buttons under it explain the rest. */
export const WELCOME = `Hi, I'm Knowing. Send me any video and I'll remember exactly what it showed. Ask me about it later, by text or voice.

Tap a topic to see how it works. /help brings this back.`;

/** One page of the guide behind the buttons under WELCOME. */
interface GuidePage {
  id: string;
  button: string;
  text(limits: { videos: number; questions: number }): string;
}

export const GUIDE: GuidePage[] = [
  {
    id: "save",
    button: "📥 Saving videos",
    text: () => `<b>Saving videos</b>
In TikTok (or YouTube and most apps), tap Share, then Telegram, then me. You can also send a video file in any format, a GIF or a round video, or paste a link.

Instagram, X and Facebook don't let me download from a link. Paste one anyway: I save what the post says, and the video file you send next fills in that same save. For Instagram, /instagram shows how to share Reels to me there instead.

I watch it, listen to it and read what's on screen, then tell you what I kept.`,
  },
  {
    id: "ask",
    button: "💬 Asking",
    text: () => `<b>Asking about your videos</b>
Ask in your own words, like "what went in that pasta sauce?" or "the workout I saved last week". Or hold the mic and ask by voice (up to a minute).

I'll tell you where in the video it happens, like "At 0:42", and link the video. You can also just chat with me about anything.`,
  },
  {
    id: "folders",
    button: "📂 Folders",
    text: () => `<b>Folders</b>
I file every video into a folder for you, like Cooking or Gym. /folders shows them, and tapping one lists its videos.

In the wrong folder? Tap Fix something on the save and tell me where it goes.`,
  },
  {
    id: "flashback",
    button: "🧠 Weekly flashback",
    text: () => `<b>Weekly flashback</b>
If you turn it on, every Sunday I send a short note with what you saved that week, or a few older videos worth another look. It's off unless you want it. /digest turns it on or off.`,
  },
  {
    id: "limits",
    button: "⭐ Limits and extras",
    text: (limits) => `<b>Limits and extras</b>
You start with ${limits.videos} free videos and ${limits.questions} free questions, given once. /usage shows what's left, and /buy gets more any time. Extras never expire.

/invite gives you your own link. When a friend joins with it, saves a video and asks me something, you get 3 free videos (for up to 5 friends).`,
  },
  {
    id: "data",
    button: "🔒 Your data",
    text: () => `<b>Your data</b>
/memory shows what I remember about you, and /saved lists every video. /delete wipes everything. /support reaches the owner.`,
  },
];

/** The guide's topic buttons, two to a row. */
export function guideButtons(): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < GUIDE.length; i += 2) rows.push(GUIDE.slice(i, i + 2).map((g) => ({ text: g.button, callback_data: `guide:${g.id}` })));
  return rows;
}
