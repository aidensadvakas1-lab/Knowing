/**
 * A small, safe Markdown renderer for chat answers.
 *
 * It supports only what coaching answers need: headings, paragraphs, bullet
 * and numbered lists, bold, italic, inline code and links. All text is HTML
 * escaped first, and links are limited to http(s), so model output can never
 * inject markup or scripts into the page.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a string for safe use inside HTML text or attribute values. */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Render inline Markdown (code, bold, italic, links) within one line of text. */
export function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

/**
 * Render a block of Markdown to HTML.
 *
 * Headings are shifted down one level (`#` becomes `<h2>`) because the page
 * already owns `<h1>`.
 */
export function renderMarkdown(source: string): string {
  const lines = source.split("\n");
  let html = "";
  let list: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${renderInline(paragraph.join(" "))}</p>`;
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      html += `</${list}>`;
      list = null;
    }
  };
  const openList = (kind: "ul" | "ol") => {
    if (list !== kind) {
      closeList();
      html += `<${kind}>`;
      list = kind;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let match: RegExpMatchArray | null;

    if (!line.trim()) {
      flushParagraph();
      closeList();
    } else if ((match = line.match(/^(#{1,4})\s+(.*)/))) {
      flushParagraph();
      closeList();
      const level = Math.min(4, match[1].length + 1);
      html += `<h${level}>${renderInline(match[2])}</h${level}>`;
    } else if ((match = line.match(/^\s*[-*•]\s+(.*)/))) {
      flushParagraph();
      openList("ul");
      html += `<li>${renderInline(match[1])}</li>`;
    } else if ((match = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      flushParagraph();
      openList("ol");
      html += `<li>${renderInline(match[1])}</li>`;
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  closeList();
  return html;
}
