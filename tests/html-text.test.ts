import { describe, expect, it } from "vitest";
import { decodeEntities, extractTitle, htmlToText } from "@/lib/html-text";

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &#39;s &#x2014; &nbsp;ok")).toBe("Tom & Jerry 's —  ok");
  });
  it("leaves unknown entities alone", () => expect(decodeEntities("&bogus;")).toBe("&bogus;"));
});

describe("extractTitle", () => {
  it("reads and cleans the title", () => expect(extractTitle("<title>\n How &amp; Why </title>")).toBe("How & Why"));
  it("returns empty when missing", () => expect(extractTitle("<p>x</p>")).toBe(""));
});

describe("htmlToText", () => {
  it("prefers the article, strips scripts and nav, keeps line breaks", () => {
    const html = `<nav>Menu</nav><script>evil()</script><article><h1>Title</h1><p>First   para.</p><p>Second</p></article><footer>f</footer>`;
    expect(htmlToText(html)).toBe("Title\nFirst para.\nSecond");
  });
});
