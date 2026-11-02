/**
 * Which app a link is from, and what counts as a video file, so the bot can
 * take any video it's sent and say plainly what to do when a link's video
 * can't be downloaded.
 */
import { parseHttpUrl } from "../sources";

/** File endings of video formats ffmpeg reads. */
export const VIDEO_EXT = /\.(mp4|m4v|mov|qt|webm|mkv|avi|3gp|3g2|mpe?g|mts|m2ts|ts|flv|wmv|ogv|hevc)$/i;

/** Which app a link is from, in the words people use, or "" for anything else. */
export function platformName(url: string): string {
  const host = parseHttpUrl(url)?.hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "") ?? "";
  const names: Array<[RegExp, string]> = [
    [/(^|\.)tiktok\.com$/, "TikTok"],
    [/(^|\.)(instagram\.com|instagr\.am)$/, "Instagram"],
    [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube"],
    [/(^|\.)(x\.com|twitter\.com|t\.co)$/, "X"],
    [/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/, "Facebook"],
    [/(^|\.)threads\.(net|com)$/, "Threads"],
    [/(^|\.)(reddit\.com|redd\.it)$/, "Reddit"],
    [/(^|\.)snapchat\.com$/, "Snapchat"],
    [/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/, "Pinterest"],
    [/(^|\.)vimeo\.com$/, "Vimeo"],
    [/(^|\.)twitch\.tv$/, "Twitch"],
    [/(^|\.)linkedin\.com$/, "LinkedIn"],
  ];
  return names.find(([re]) => re.test(host))?.[1] ?? "";
}

/** A link straight to a video file (it ends in .mp4, .mov and so on). */
export function isVideoFileLink(url: string): boolean {
  return VIDEO_EXT.test(parseHttpUrl(url)?.pathname ?? "");
}

/** A file sent to the bot that is a video: by its type, or by its name when the type is missing or generic. */
export function isVideoFile(file: { mime_type?: string; file_name?: string } | undefined): boolean {
  if (!file) return false;
  return Boolean(file.mime_type?.startsWith("video/") || (file.file_name && VIDEO_EXT.test(file.file_name)));
}

/** Apps whose pages show the bot a login wall, so their page text is junk and only the video file helps. */
export const LOGIN_WALLED = new Set(["Instagram", "Facebook", "Threads", "X", "Snapchat"]);

/**
 * What to tell someone when a link's video can't be downloaded, so they can
 * still get it watched: save it in the app and send the file, which always works.
 */
export function sendTheFileNote(platform: string): string {
  return `${platform} doesn't let me download videos from a link. To have me watch this one, save it in ${platform} (or screen-record it) and send me the file. Any video format works.`;
}
