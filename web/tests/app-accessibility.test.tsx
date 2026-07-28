import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "../src/App";

describe("App accessibility structure", () => {
  it("provides a skip target, one workspace heading, and an ARIA tab interface", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('class="skip-link" href="#workspace-content"');
    expect(html).toContain(
      'id="workspace-content" aria-labelledby="workspace-title" tabindex="-1"',
    );
    expect(html).toContain('<h1 id="workspace-title">New task</h1>');
    expect(html).toContain(
      'class="workspace-view-switch" role="tablist" aria-label="Workspace view"',
    );
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain(
      'id="workspace-tab-ide" class="is-active" type="button" role="tab" aria-selected="true" aria-controls="workspace-panel-ide" tabindex="0"',
    );
    expect(html).toContain(
      'id="workspace-tab-chat" class="" type="button" role="tab" aria-selected="false" aria-controls="workspace-panel-chat" tabindex="-1"',
    );
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
  });
});
