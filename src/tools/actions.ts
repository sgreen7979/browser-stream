import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { click, fill, navigate, pressKey, scroll } from "../actions/engine.js";
import { ensureConnected } from "../cdp/client.js";

export function registerActionTools(server: McpServer): void {
  server.tool(
    "browser_click",
    "Click an element by ref. Returns action consequences.",
    { ref: z.string().describe("Element ref, e.g. @e5") },
    async ({ ref }) => {
      await ensureConnected();
      return {
        content: [{ type: "text", text: JSON.stringify(await click(ref)) }],
      };
    },
  );

  server.tool(
    "browser_fill",
    "Fill a text input by ref. Returns action consequences.",
    {
      ref: z.string().describe("Element ref, e.g. @e3"),
      value: z.string().describe("Value to fill"),
    },
    async ({ ref, value }) => {
      await ensureConnected();
      return {
        content: [{ type: "text", text: JSON.stringify(await fill(ref, value)) }],
      };
    },
  );

  server.tool(
    "browser_navigate",
    "Navigate to a URL. Returns snapshot of the new page.",
    { url: z.string().describe("URL to navigate to") },
    async ({ url }) => {
      await ensureConnected();
      return {
        content: [{ type: "text", text: JSON.stringify(await navigate(url)) }],
      };
    },
  );

  server.tool(
    "browser_press_key",
    "Press a key or key combination. Returns action consequences.",
    { key: z.string().describe('Key or combo, e.g. "Enter", "Control+a"') },
    async ({ key }) => {
      await ensureConnected();
      return {
        content: [{ type: "text", text: JSON.stringify(await pressKey(key)) }],
      };
    },
  );

  server.tool(
    "browser_scroll",
    "Scroll the viewport or the nearest scrollable ancestor of a ref.",
    {
      ref: z.string().optional().describe("Optional element ref inside target scroll container"),
      direction: z.enum(["up", "down"]).describe("Scroll direction"),
      amount: z
        .union([z.enum(["page", "to-top", "to-bottom"]), z.number()])
        .optional()
        .describe('Amount: "page", "to-top", "to-bottom", or pixel count'),
    },
    async ({ ref, direction, amount }) => {
      await ensureConnected();
      return {
        content: [{ type: "text", text: JSON.stringify(await scroll({ ref, direction, amount })) }],
      };
    },
  );
}
