# Saving Reels straight from Instagram

Instagram doesn't let a bot download a Reel from its link. It does give a Reel
to a business account when someone shares it there in a DM. That's Instagram's
own Messaging API, the official route. So Knowing gets its own Instagram
account, and people use it like this:

1. **Once:** send `/instagram` to the bot in Telegram. It replies with a code.
   Send that code to Knowing's Instagram account in a DM, and the two are linked.
2. **Every Reel after that:** tap **Share** on the Reel, pick Knowing, and send.
   The bot watches it and the save shows up in Telegram, exactly like a TikTok.
   It uses one video, like any other save.

If someone pastes an Instagram link into Telegram instead, the bot tells them to
share the Reel to Knowing on Instagram. If the Reel arrives within 30 minutes, it
fills in that same save and keeps the link.

Nothing here costs money. It only takes setup, and Meta has to review the app
before people who aren't testers can use it.

## What you need

- Knowing's own Instagram account, switched to a **professional** account (free).
- A Meta developer account and app (free).
- About an hour, then a wait for Meta's App Review (usually a few days, sometimes
  a few weeks). Testers can use it before then.

## 1. Make Knowing's Instagram account professional

1. Make an Instagram account for Knowing, for example `getknowing`.
2. In the Instagram app, go to **Settings → Account type and tools → Switch to
   professional account**. Pick **Business** or **Creator**.
3. Go to **Settings → Messages and story replies → Message controls → Connected
   tools** and turn on **Allow access to messages**. Without this, Instagram
   sends the bot nothing.

## 2. Make the Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps), and click **Create app**.
2. For the use case, pick **Manage messaging & content on Instagram**.
3. Open **API setup with Instagram login**.
4. Under **Generate access tokens**, click **Add account** and log in as
   Knowing's Instagram account. The bot doesn't need this token, but adding the
   account here is what connects it.
5. On the same page, copy the **Instagram app secret**.

## 3. Add the settings in Vercel

In Vercel, go to **Settings → Environment Variables**, add these, and redeploy:

| Name | Value |
|---|---|
| `INSTAGRAM_USERNAME` | Knowing's Instagram username, without `@` (for example `getknowing`) |
| `INSTAGRAM_APP_SECRET` | The Instagram app secret from step 2.5 |
| `INSTAGRAM_VERIFY_TOKEN` | Any long random phrase you make up. You'll paste the same phrase into Meta next |
| `META_APP_SECRET` | Optional but recommended: **App settings → Basic → App secret**. Meta signs some deliveries with this one instead, and the bot accepts either |
| `META_APP_ID` | Optional: **App settings → Basic → App ID**. With `META_APP_SECRET`, pasted Instagram links get their caption saved right away. This needs the app's **oEmbed Read** feature, so leave it out if you don't add that |

The bot ignores Instagram until `INSTAGRAM_USERNAME` and one of the secrets are set.

## 4. Connect the webhook

1. Back in **API setup with Instagram login**, find **Configure webhooks**.
2. Set the **Callback URL** to `https://<your-vercel-domain>/api/instagram`, for example
   `https://knowing-jet.vercel.app/api/instagram`.
3. Set the **Verify token** to the same phrase as `INSTAGRAM_VERIFY_TOKEN`, and
   click **Verify and save**. If it fails, check that the redeploy finished.
4. Subscribe to the **messages** field.
5. Turn on the webhook subscription for Knowing's account in the account list on
   that page.
6. Open the Telegram setup link once more
   (`/api/telegram/setup?key=<TELEGRAM_WEBHOOK_SECRET>`), so `/instagram` shows in the
   menu. Its reply says `"instagram": {"account": "@getknowing", ...}` when everything is set.

## 5. Test it with testers

Before App Review, Meta only delivers messages from people who have a role on the
app.

1. Go to **App roles → Roles**, and add yourself and your beta friends as
   **Instagram Testers**, using their Instagram usernames.
2. Each person accepts the invite in Instagram: **Settings → Apps and websites →
   Tester invites**.
3. Switch the app to **Live** at the top of the dashboard. Meta asks for a privacy
   policy URL first: use `https://<your-vercel-domain>/privacy`. The same page
   covers data deletion.
4. In Telegram, send `/instagram`, DM the code to Knowing on Instagram, then
   share a Reel to it.

If nothing arrives, look at Vercel's logs for `/api/instagram`:

- **No request at all:** the subscription or the account's "Allow access to messages" setting is off.
- **A 403:** the secret doesn't match. Add `META_APP_SECRET` too.

## 6. App Review (so anyone can use it)

In **App Review → Permissions and features**, request:

- `instagram_business_basic`
- `instagram_business_manage_messages`

Meta asks for:

- what the app does
- the privacy policy URL
- a short screen recording of a Reel being shared to Knowing and showing up in Telegram

Meta may also ask for **business verification** before it gives full access. Testers keep working while you wait.

## Good to know

- **Private accounts.** A Reel from a private account may not come through.
- **Videos.** Only the first 5 minutes are watched, like every other video. Downloads are capped at 60 MB.
- **Duplicates.** Meta sometimes delivers a message twice. The bot skips repeats it has already seen.
- **One account per person.** An Instagram account links to one Telegram account at a time. Linking it again moves it.
- **Unlinking.** `/instagram off` unlinks it, and `/delete` removes the link along with everything else.
- **Accounts nobody linked.** DMs from them are ignored by the bot, but you can still read them in the Instagram app.
