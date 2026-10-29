/**
 * A tiny Telegram Bot API client: just the calls the bot uses.
 * https://core.telegram.org/bots/api
 */
import "server-only";
import type { InlineButton, TelegramApi } from "./types";

/** Telegram rejects messages over 4096 characters. */
const MAX_TEXT = 4000;

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export class Telegram implements TelegramApi {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new TelegramError(`${method}: ${json.description ?? res.status}`, res.status);
    return json.result as T;
  }

  async sendMessage(chatId: number, html: string, buttons?: InlineButton[][]): Promise<number> {
    const msg = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: html.slice(0, MAX_TEXT),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    return msg.message_id;
  }

  async editMessage(chatId: number, messageId: number, html: string, buttons?: InlineButton[][]): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html.slice(0, MAX_TEXT),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buttons ?? [] },
      });
    } catch (error) {
      // Tapping the same button twice edits to identical text, which Telegram rejects. Harmless.
      if (!(error instanceof TelegramError && /not modified/i.test(error.message))) throw error;
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) }).catch(() => {});
  }

  async typing(chatId: number): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  }

  /**
   * One-time setup: point Telegram at our webhook and fill in the bot's
   * commands menu and profile text. Safe to run again.
   */
  async setup(webhookUrl: string, secret: string, profile: { commands: ReadonlyArray<{ command: string; description: string }>; description: string; shortDescription: string }) {
    await this.call("setWebhook", { url: webhookUrl, secret_token: secret, allowed_updates: ["message", "callback_query"] });
    await this.call("setMyCommands", { commands: profile.commands });
    await this.call("setMyDescription", { description: profile.description });
    await this.call("setMyShortDescription", { short_description: profile.shortDescription });
    return this.call<{ username?: string }>("getMe", {});
  }

  /** A download URL for a file sent to the bot (bots can fetch files up to 20 MB). */
  async fileUrl(fileId: string): Promise<string> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("getFile: no file_path", 400);
    return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
  }
}
