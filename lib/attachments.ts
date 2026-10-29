/**
 * Files attached to a chat message with the + button. Pure helpers for
 * sorting files by kind and describing them, shared by client and server.
 */
import { ATTACHMENTS } from "./constants";

/** Image types Claude can read. */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** File extensions read as plain text. */
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "json", "srt", "vtt", "html", "htm", "xml", "yaml", "yml", "log", "rtf"];

/** What the + button does with a picked file. */
export type AttachmentKind = "video" | "image" | "pdf" | "text" | "unsupported";

/** An attachment as sent to `POST /api/chat`. */
export type ChatAttachment =
  | { type: "image"; name: string; mediaType: ImageType; data: string }
  | { type: "pdf"; name: string; data: string }
  | { type: "text"; name: string; text: string };

/** Sort a picked file by its MIME type, falling back to its extension. */
export function classifyFile(file: { name: string; type: string }): AttachmentKind {
  const type = file.type.toLowerCase();
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (type.startsWith("video/") || ["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(ext)) return "video";
  if (type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"].includes(ext)) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json" || TEXT_EXTENSIONS.includes(ext)) return "text";
  return "unsupported";
}

/** Total base64 characters of the binary attachments (images and PDFs). */
export function binaryChars(attachments: ChatAttachment[]): number {
  return attachments.reduce((sum, a) => sum + (a.type === "text" ? 0 : a.data.length), 0);
}

/** True when the binary attachments fit in one request. */
export function fitsInRequest(attachments: ChatAttachment[]): boolean {
  return binaryChars(attachments) <= ATTACHMENTS.totalBinaryChars;
}

/** The line saved in chat history for a message's attachments, e.g. "Attached: plan.pdf, clip.mp4". */
export function attachedLine(names: string[]): string {
  return names.length ? `Attached: ${names.join(", ")}` : "";
}
