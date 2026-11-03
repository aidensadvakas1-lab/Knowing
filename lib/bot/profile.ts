/**
 * How the bot presents itself in Telegram (the commands menu, the profile
 * text, the first message and its guide), and everything it knows about
 * itself. /commands, the guide and what the AI is told about Knowing (ABOUT
 * below) all come from the lists here, so a new command or feature is
 * explained everywhere by adding it once.
 *
 * The menu is set with GET /api/telegram/setup.
 */
import { priceList } from "./shop";
import type { Pack } from "./types";

/** What the guide and the AI need to know that changes with settings. */
export interface Setup {
  limits: { videos: number; questions: number };
  packs: Pack[];
  /** Anyone can start it with the bot's link. False means invite-only. */
  open: boolean;
  /** Knowing's Instagram account, when Reels can be shared to it (docs/INSTAGRAM.md). */
  instagram?: string;
}

/** One command and what it does. `menu` puts it in Telegram's menu (with `short`). */
interface Command {
  command: string;
  short: string;
  /** What it does, for /commands and the AI. */
  does: string;
  menu?: boolean;
  /** Only shown when Instagram sharing is set up. */
  instagram?: boolean;
}

/** Every command anyone can use, in the order /commands lists them. */
export const ALL_COMMANDS: Command[] = [
  { command: "help", short: "How everything works", does: "The welcome and a tap-through guide to everything. /start does the same.", menu: true },
  { command: "commands", short: "Every command explained", does: "This list.", menu: true },
  { command: "folders", short: "Your videos in folders", does: "Your folders as buttons. Tap one to see its videos, then rename it, merge it into another or delete it (its videos move to Unsorted, so nothing is lost). Big folders are split into sections for you.", menu: true },
  { command: "saved", short: "Everything you've saved", does: "Every video you've saved, folder by folder, each linked.", menu: true },
  { command: "digest", short: "Weekly flashback on or off", does: "Your weekly flashback: every Sunday, what you saved that week or a few older videos worth another look. /digest on and /digest off turn it on and off. It's off unless you turn it on.", menu: true },
  { command: "memory", short: "What I remember about you", does: "What I remember about you, with a button to forget each thing.", menu: true },
  { command: "usage", short: "What you have left", does: "Your free videos and questions left, and any extras you bought or earned. Free to check. /limits does the same.", menu: true },
  { command: "buy", short: "Get more videos or questions", does: "Packs of extra videos or questions, paid with Telegram Stars. They never expire.", menu: true },
  { command: "invite", short: "Invite friends, earn free videos", does: "Your own invite link. When a friend joins with it, saves a video and asks me something, you get 3 free videos, for up to 5 friends.", menu: true },
  { command: "instagram", short: "Save Reels straight from Instagram", does: "Links your Instagram, so Reels you share to Knowing's Instagram account (Share, then Message) are saved here. /instagram off unlinks it.", menu: true, instagram: true },
  { command: "support", short: "Ask the owner for help", does: "Sends your message to the owner, like /support it didn't answer me. The reply comes here.", menu: true },
  { command: "paysupport", short: "Help with a payment", does: "For a payment problem or a refund, like /paysupport I paid but didn't get my videos." },
  { command: "terms", short: "The rules for buying", does: "The terms for using Knowing and buying extras." },
  { command: "delete", short: "Delete all your data", does: "Deletes every save, our chats and everything I remember about you, after you confirm. Extras you bought stay.", menu: true },
];

/** Only for whoever runs the bot. */
export const OWNER_COMMANDS: Command[] = [
  { command: "invite", short: "", does: "For you, the owner: the bot's main link, and how many people have joined." },
  { command: "refund", short: "", does: "/refund user_id payment_id refunds a Star payment (each payment message has the exact command)." },
  { command: "reply", short: "", does: "/reply user_id message answers someone's /support or /paysupport." },
];

/** Shown in the menu button next to the message box. */
export const COMMANDS = ALL_COMMANDS.filter((c) => c.menu).map(({ command, short }) => ({ command, description: short }));

/** Shown on the empty chat before someone taps Start (max 512 characters). */
export const DESCRIPTION =
  "Send me videos you want to keep: recipes, workouts, game setups, how-tos, ideas. I watch and listen to each one, remember exactly what it showed and file it in a folder. Later, ask in your own words, by text or voice, and get that exact thing back, with the moment it happens.";

/** Shown on the bot's profile and in shares (max 120 characters). */
export const SHORT_DESCRIPTION = "Remembers the videos you send it and keeps them in folders, so you can ask about them later.";

/** The first message, kept short. The guide buttons under it explain the rest. */
export const WELCOME = `Hi, I'm Knowing. Send me any video and I'll remember exactly what it showed and file it for you. Ask me about it later, by text or voice.

Tap a topic to see how it works. /commands lists everything.`;

const free = (s: Setup) => `${s.limits.videos} free videos and ${s.limits.questions} free questions`;
const prices = (s: Setup) => (s.packs.length ? `${priceList(s.packs, "videos")}; ${priceList(s.packs, "questions")}` : "");

/** One page of the guide behind the buttons under WELCOME. */
interface GuidePage {
  id: string;
  button: string;
  text(setup: Setup): string;
}

export const GUIDE: GuidePage[] = [
  {
    id: "save",
    button: "📥 Saving videos",
    text: () => `<b>Saving videos</b>
In TikTok (or YouTube and most apps), tap Share, then Telegram, then me. You can also send a video file in any format, a GIF or a round video, or paste a link.

Instagram, X and Facebook don't let me download from a link. Paste one anyway: I save what the post says, and the video file you send next fills in that same save. For Instagram, /instagram shows how to share Reels to me there instead.

I watch it, listen to it and read what's on screen, then tell you what I kept and which folder it's in.

Under each video: <b>Show steps</b>, <b>Start now</b> (go through it step by step), <b>📂</b> (move it to another folder), <b>Fix something</b> (tell me what I got wrong) and <b>Add what it says</b> (when I couldn't hear it).`,
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
I file every video in a folder, like Cooking or Gym. /folders shows them.

• <b>Move a video:</b> tap 📂 under it and pick a folder, or make a new one.
• <b>Move lots at once:</b> just ask, like "put my pasta videos in Dinner ideas".
• <b>Rename, merge or delete</b> a folder: open it in /folders. Deleting moves its videos to Unsorted, so nothing is lost.
• <b>Rules:</b> say "anything about cars goes in Car mods" and new videos follow it.

I learn from where you put things, and big folders split into sections by themselves.`,
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
    text: (s) => `<b>Limits and extras</b>
You start with ${free(s)}, given once. Asking me to move videos uses a question; the buttons are free. /usage shows what's left, and /buy gets more any time${prices(s) ? `: ${prices(s)}` : ""}. Extras never expire.

/invite gives you your own link. When a friend joins with it, saves a video and asks me something, you get 3 free videos (for up to 5 friends).`,
  },
  {
    id: "data",
    button: "🔒 Your data",
    text: () => `<b>Your data</b>
/memory shows what I remember about you, and /saved lists every video. /delete wipes everything. /support reaches the owner.`,
  },
  {
    id: "commands",
    button: "📋 All commands",
    text: (s) => commandsText(false, Boolean(s.instagram)),
  },
];

/** The guide's topic buttons, two to a row. */
export function guideButtons(): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < GUIDE.length; i += 2) rows.push(GUIDE.slice(i, i + 2).map((g) => ({ text: g.button, callback_data: `guide:${g.id}` })));
  return rows;
}

/** The commands that work with these settings (/instagram only once it's set up). */
const available = (instagram = false) => ALL_COMMANDS.filter((c) => !c.instagram || instagram);

/** /commands: every command and what it does, plus the owner's own when it's them. */
export function commandsText(owner = false, instagram = false): string {
  const line = (c: Command) => `/${c.command} · ${c.does}`;
  const lines = ["📋 <b>Every command</b>", "", ...available(instagram).map(line)];
  if (owner) lines.push("", "<b>Only for you, the owner</b>", ...OWNER_COMMANDS.map(line));
  lines.push("", "You don't need commands for most things: send a video to save it, and ask or say anything else in your own words.");
  return lines.join("\n");
}

/**
 * Everything Knowing is and does, for the AI that answers, so "how do I move
 * a video?", "what does /digest do?" or "how much is a pack?" gets the real
 * answer. Plain text, built from the same lists as /commands and the guide.
 */
export function aboutKnowing(s: Setup, owner = false): string {
  const commands = [...available(Boolean(s.instagram)), ...(owner ? OWNER_COMMANDS : [])].map((c) => `/${c.command}: ${c.does}`).join("\n");
  const instagram = s.instagram
    ? ` Instagram Reels can also be shared straight from Instagram: after linking with /instagram, Share, then Message, then @${s.instagram}, and the Reel is watched and saved here.`
    : "";
  return `What Knowing is: a Telegram bot. People send it videos to keep, and it watches each one (frames, speech and on-screen text, the first 5 minutes), saves exactly what it showed, files it in a folder and reacts like a friend. Later they ask about them in their own words, by text or a voice message (up to a minute), and get the exact thing back with the moment in the video and a link. They can also just chat; it remembers what they tell it and every chat.
Saving: share from TikTok, YouTube and most apps (Share, then Telegram, then Knowing), paste a link, or send a video file in any format, a GIF or a round video (Telegram lets bots take files up to 20 MB). Instagram, X and Facebook don't let it download from a link. A link from those saves what the post says for free (no video used), and a video file sent within 30 minutes fills in that same save.${instagram}
Buttons under a saved video: Show steps; Start now (step by step, for drills and plans); 📂 with its folder's name (move it, or make a new folder); Fix something (say what's wrong and it's corrected); Add what it says (paste the words when it couldn't hear them); Keep both or Replace the old one (when it's a repeat). A save's full card (from Show steps, or a number in a folder) also has Delete.
Folders: every video is in one. It picks the folder, going by their folders, what they've moved where and their rules. They move a video with 📂, or many at once by asking ("put my pasta videos in Dinner ideas"), rename, merge or delete a folder in /folders (deleting moves its videos to Unsorted) or by asking, and set rules by asking ("anything about cars goes in Car mods"). Big folders split into sections by themselves.
Weekly flashback: off unless they turn it on; Sundays around 17:00 UTC; what they saved that week, or older videos worth another look.
Limits: everyone starts with ${free(s)}, given once; they don't refill. Each message to the AI uses a question (asking it to move or rename things too); buttons, commands and checking what's left don't. ${s.packs.length ? `After that, packs paid with Telegram Stars: ${prices(s)}. They never expire and are used after the free ones.` : "Buying more is turned off right now."} Friends: their own /invite link earns 3 free videos per friend who joins, saves a video and asks something (up to 5 friends). ${s.open ? "Anyone can start Knowing with its link." : "Knowing is invite-only for now: people join with an invite link."}
Payments: /paysupport for problems or refunds; /terms has the rules. Telegram's own support can't help with purchases in a bot.
Commands:
${commands}`;
}
