import { describe, expect, it } from "vitest";
import { searchOnDemandTools } from "./on-demand-tool-search.js";

const tools = [
  { name: "tool_docs", displayName: "Search docs", description: "PowerShell and Windows administration" },
  { name: "windows-shell", displayName: "Run PowerShell", applicationDisplayName: "Windows Tools", description: "Execute a command" },
  { name: "ps_info", displayName: "PowerShell details", applicationDisplayName: "Windows" },
  { name: "unrelated", displayName: "Calendar", description: "Manage events" },
];

describe("searchOnDemandTools", () => {
  it("normalizes punctuation and hyphens, matches query tokens across fields, and ranks names above descriptions", () => {
    expect(searchOnDemandTools(tools, "Windows PowerShell", 10).map((tool) => tool.name)).toEqual([
      "windows-shell",
      "ps_info",
      "tool_docs",
    ]);
    expect(searchOnDemandTools(tools, "windows-PowerShell", 10).map((tool) => tool.name)).toEqual([
      "windows-shell",
      "ps_info",
      "tool_docs",
    ]);
  });

  it("searches application display names and applies the limit after relevance ordering", () => {
    expect(searchOnDemandTools(tools, "Windows", 1).map((tool) => tool.name)).toEqual(["windows-shell"]);
  });

  it("retains partial-token search and normalizes Unicode diacritics", () => {
    expect(searchOnDemandTools(tools, "powersh", 10).map((tool) => tool.name)).toEqual([
      "windows-shell",
      "ps_info",
      "tool_docs",
    ]);
    expect(searchOnDemandTools([{ name: "prüfen" }], "prufen", 10)).toEqual([{ name: "prüfen" }]);
  });

  it("preserves discovery order for an empty query and returns no tools for no match", () => {
    expect(searchOnDemandTools(tools, "---", 2).map((tool) => tool.name)).toEqual(["tool_docs", "windows-shell"]);
    expect(searchOnDemandTools(tools, "qzxv-blorf", 10)).toEqual([]);
  });
});
