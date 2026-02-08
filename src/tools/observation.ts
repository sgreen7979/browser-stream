import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureConnected, getClient, isCrashed } from "../cdp/client.js";
import { takeSnapshot, snapshotDataToResult, errorSnapshotResult } from "../state/snapshot.js";
import { waitFor } from "../actions/engine.js";

export function registerObservationTools(server: McpServer): void {
  server.tool(
    "browser_snapshot",
    "Take a snapshot of the current page. Returns interactive elements with @e refs.",
    async () => {
      const start = Date.now();
      try {
        await ensureConnected();
        const cdp = getClient();
        const data = await takeSnapshot(cdp);
        return {
          content: [{ type: "text", text: JSON.stringify(snapshotDataToResult(data, Date.now() - start)) }],
        };
      } catch {
        const errors = isCrashed()
          ? [{ code: "PAGE_CRASHED" as const, message: "Chrome tab crashed" }]
          : [{ code: "CDP_DISCONNECTED" as const, message: "CDP connection lost" }];
        return {
          content: [{ type: "text", text: JSON.stringify(errorSnapshotResult(errors, Date.now() - start)) }],
        };
      }
    },
  );

  server.tool(
    "browser_wait_for",
    "Wait for text to appear or a ref to become visible. Polls every 500ms.",
    {
      text: z.string().optional().describe("Text to wait for (case-insensitive substring match)"),
      ref: z.string().optional().describe("Ref to wait for (e.g. @e5)"),
      timeout: z.number().optional().describe("Timeout in ms (default 10000)"),
    },
    async ({ text, ref, timeout }) => {
      await ensureConnected();
      return {
        content: [{ type: "text", text: JSON.stringify(await waitFor({ text, ref, timeout })) }],
      };
    },
  );
}
