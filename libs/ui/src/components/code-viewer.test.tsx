import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CodeViewer } from "./code-viewer";

describe("CodeViewer", () => {
  it("mounts a CodeMirror editor and renders the value", () => {
    const { container } = render(
      <CodeViewer value={'{"hello":"world"}'} language="json" />,
    );
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(container.textContent).toContain("hello");
  });
});
