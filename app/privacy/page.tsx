import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · Knowing",
  description: "What the Knowing bot keeps, why, and how to delete it.",
};

/**
 * /privacy: the privacy policy and data deletion instructions. Meta's App
 * Review asks for both URLs before Knowing's Instagram account can take Reels
 * from everyone (docs/INSTAGRAM.md), and the same page covers Telegram.
 */
export default function Privacy() {
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "32px 16px 48px" }}>
      <h1 style={{ fontFamily: "var(--f-display)", marginTop: 0 }}>Knowing privacy policy</h1>
      <p style={{ color: "var(--muted)" }}>Last updated November 2, 2026.</p>

      <p>
        Knowing is a bot that remembers the videos you send it. You use it in Telegram (@GetKnowingBot), and you can share Reels to Knowing&apos;s Instagram account. This page
        says what it keeps and how to delete it.
      </p>

      <h2>What Knowing keeps</h2>
      <ul>
        <li>Your Telegram id and first name, so it knows who it&apos;s talking to.</li>
        <li>Notes about each video you send or share: a title, the steps, details, its caption, what was said and what was on screen, a link to it, and when you saved it. The video file itself isn&apos;t kept.</li>
        <li>Your chats with the bot, and short facts you mention about yourself (like &quot;I play on PC&quot;), so it can answer in context. /memory shows the facts.</li>
        <li>How many free videos and questions you&apos;ve used, what you bought with Telegram Stars, and who invited you.</li>
        <li>If you link Instagram with /instagram: the Instagram-scoped id of your account (not your password or your other messages), and the Reels and posts you share to Knowing&apos;s account.</li>
      </ul>

      <h2>Why, and who else sees it</h2>
      <p>Only to run the bot for you: watching videos, answering your questions and finding the right saves. It isn&apos;t sold, and there are no ads. To do that work, it&apos;s sent to:</p>
      <ul>
        <li>Anthropic (Claude), which watches videos and writes answers.</li>
        <li>OpenAI, which turns speech into text and makes the search index.</li>
        <li>Supabase, where it&apos;s stored, and Vercel, where the bot runs.</li>
        <li>Telegram and Meta (Instagram), which carry the messages.</li>
      </ul>
      <p>Payments are handled by Telegram. Knowing never sees card details.</p>

      <h2>Deleting your data</h2>
      <ul>
        <li>Send <code>/delete</code> to @GetKnowingBot in Telegram and confirm. That erases your saves, your chats, what it remembers about you and your Instagram link, right away.</li>
        <li>To only unlink Instagram, send <code>/instagram off</code>. Reels you share after that are ignored.</li>
        <li>A small record stays so deleting doesn&apos;t hand out new free uses: your Telegram id, how many free ones you used, extras you bought and who invited you.</li>
        <li>Can&apos;t use the bot? Send <code>/support</code> in Telegram, or DM Knowing on Instagram, and ask for your data to be deleted.</li>
      </ul>

      <h2>Questions</h2>
      <p>
        Send <code>/support</code> to @GetKnowingBot in Telegram.
      </p>
    </main>
  );
}
