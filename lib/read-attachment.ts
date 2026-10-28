/**
 * Browser-side reading of chat attachments: images are shrunk and re-encoded
 * as JPEG, PDFs are read as base64, text files as text.
 */
import { type ChatAttachment, type ImageType, IMAGE_TYPES } from "./attachments";
import { ATTACHMENTS } from "./constants";

/** A file the user can fix (too big, unreadable). */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Shrink an image to fit the size limit and re-encode it as JPEG. */
async function readImage(file: File): Promise<ChatAttachment> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AttachmentError(`Couldn't open ${file.name}. Try a JPEG or PNG.`);
  }
  const scale = Math.min(1, ATTACHMENTS.imageMaxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const small = scale === 1 && file.size < 1_000_000 && (IMAGE_TYPES as readonly string[]).includes(file.type);
  if (small) {
    bitmap.close();
    return { type: "image", name: file.name, mediaType: file.type as ImageType, data: toBase64(await file.arrayBuffer()) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
  return { type: "image", name: file.name, mediaType: "image/jpeg", data };
}

/** Read one picked file (not a video) into an attachment. */
export async function readAttachment(file: File, kind: "image" | "pdf" | "text"): Promise<ChatAttachment> {
  if (kind === "text") {
    const text = (await file.text()).slice(0, ATTACHMENTS.textChars);
    return { type: "text", name: file.name, text };
  }
  if (file.size > ATTACHMENTS.maxPickBytes) throw new AttachmentError(`${file.name} is too big.`);
  if (kind === "image") return readImage(file);
  return { type: "pdf", name: file.name, data: toBase64(await file.arrayBuffer()) };
}
