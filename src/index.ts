import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect, disconnect } from "./cdp/client.js";
import { registerActionTools } from "./tools/actions.js";
import { registerObservationTools } from "./tools/observation.js";

function parseArgs(): { cdpUrl?: string } {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cdp-url" && args[i + 1]) {
      return { cdpUrl: args[i + 1] };
    }
  }
  return {};
}

async function main(): Promise<void> {
  const { cdpUrl } = parseArgs();

  const server = new McpServer({
    name: "browser-stream",
    version: "0.1.0",
  });

  registerActionTools(server);
  registerObservationTools(server);

  // Connect to Chrome
  console.error(`[browser-stream] Connecting to Chrome${cdpUrl ? ` at ${cdpUrl}` : " (launching)"}...`);
  await connect(cdpUrl);
  console.error("[browser-stream] Chrome connected");

  // Start MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[browser-stream] MCP server ready on stdio");

  // Graceful shutdown
  const shutdown = async () => {
    console.error("[browser-stream] Shutting down...");
    await server.close();
    await disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[browser-stream] Fatal:", err);
  process.exit(1);
});
