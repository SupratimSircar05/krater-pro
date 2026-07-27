import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownMessage from "../src/MarkdownMessage";

describe("MarkdownMessage", () => {
  it("renders GFM and code controls without accepting raw HTML", () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={[
          "## Result",
          "",
          "- **safe**",
          "",
          "[docs](https://example.com)",
          "",
          "```ts",
          "const answer = 42;",
          "```",
          "",
          '<img src=x onerror="alert(1)">',
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>safe</strong>");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain(">Copy</button>");
    expect(html).toContain("const answer = 42;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });
});
