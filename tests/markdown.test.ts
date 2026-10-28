import { describe, expect, it } from "vitest";
import { escapeHtml, renderInline, renderMarkdown } from "@/lib/markdown";

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("renderInline", () => {
  it("renders bold, italic and code", () => {
    expect(renderInline("**bold** and *it* and `x`")).toBe("<strong>bold</strong> and <em>it</em> and <code>x</code>");
  });

  it("renders http links with safe rel attributes", () => {
    expect(renderInline("[YC](https://ycombinator.com)")).toBe(
      '<a href="https://ycombinator.com" target="_blank" rel="noopener noreferrer">YC</a>',
    );
  });

  it("does not turn javascript: links into anchors", () => {
    expect(renderInline("[x](javascript:alert(1))")).not.toContain("<a");
  });
});

describe("renderMarkdown", () => {
  it("shifts headings down one level", () => {
    expect(renderMarkdown("# Plan")).toBe("<h2>Plan</h2>");
    expect(renderMarkdown("#### Deep")).toBe("<h4>Deep</h4>");
  });

  it("groups bullet and numbered lists", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2) b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("switches list type cleanly", () => {
    expect(renderMarkdown("- a\n1. b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>");
  });

  it("joins wrapped lines into one paragraph and splits on blank lines", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one two</p><p>three</p>");
  });

  it("never emits raw HTML from the model", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n- <img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });

  it("handles a partial answer mid-stream", () => {
    expect(() => renderMarkdown("## Phase 1\n- **Learn Py")).not.toThrow();
  });
});
