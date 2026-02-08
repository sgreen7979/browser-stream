# Browser Stream MCP Server

Browser Stream is a Model Context Protocol (MCP) server designed to streamline browser automation for AI agents. It "collapses" the traditional act-then-observe loop into single tool calls by providing immediate feedback on action consequences.

## Project Overview

- **Purpose**: Facilitate efficient browser interaction by combining actions (click, fill, etc.) with automated observation of their effects on the page state.
- **Main Technologies**:
  - **TypeScript**: Core language.
  - **Model Context Protocol (MCP)**: Server implementation.
  - **Chrome DevTools Protocol (CDP)**: Via `chrome-remote-interface`.
  - **tsup**: Build tool.
  - **Vitest**: Testing framework.
- **Architecture**:
  - `src/index.ts`: Entry point, initializes MCP server and CDP connection.
  - `src/cdp/`: CDP client management (launching/connecting to Chrome).
  - `src/actions/`: Core action logic (click, fill, navigate, pressKey). Includes orchestration of pre/post snapshots and stability waiting.
  - `src/state/`: Snapshot taking, element reference mapping (`@e` refs), and state diffing.
  - `src/tools/`: MCP tool definitions for actions and observations.

## Building and Running

### Prerequisites
- Node.js (Latest LTS recommended)
- Google Chrome or Chromium installed

### Commands
- **Install Dependencies**: `npm install`
- **Build**: `npm run build`
- **Development (Watch Mode)**: `npm run dev`
- **Run Tests**: `npm test`
- **Run (Production)**: `node dist/index.js`

### Testing
- **Framework**: Vitest.
- **Integration Tests**: Located in `test/integration/`. These tests use a local HTTP server to serve HTML fixtures and verify CDP interactions.
- **Predictable Refs**: Tests use `resetCounter()` from `src/state/ref-map.js` to ensure `@e` references are predictable across runs.
- **Token Budgeting**: The project includes tests to ensure that snapshots are compact and efficient for LLM consumption (measured via `tiktoken`).

### MCP Integration
To use this with an MCP client (like Claude Desktop or Gemini CLI), add it to your configuration:

```json
{
  "mcpServers": {
    "browser-stream": {
      "command": "node",
      "args": ["/path/to/browser-stream/dist/index.js"]
    }
  }
}
```

You can optionally provide `--cdp-url` to connect to an existing Chrome instance.

## Development Conventions

- **Ref-based Interaction**: Use `@e1`, `@e2`, etc. references for elements. These are mapped to `backendNodeId`s and are more stable than CSS selectors during a session.
- **Action Consequences**: Every action tool (click, fill) returns a `consequences` array showing what changed (elements appeared/disappeared/changed) and `newInteractiveElements` found in the diff.
- **Stability**: Actions wait for network and DOM stability (`src/actions/stability.ts`) before taking post-action snapshots.
- **Functional Style**: Prefer small, focused modules and pure functions where possible (e.g., `src/state/differ.ts`).

## Key Files
- `src/actions/engine.ts`: The main orchestration logic for actions.
- `src/state/snapshot.ts`: How the browser state is captured and serialized.
- `src/cdp/client.ts`: Connection management.
