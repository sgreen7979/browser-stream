# browser-stream

MCP server that collapses browser act-then-observe into single tool calls. Every action returns its consequences — what appeared, disappeared, changed, or shifted — so agents see the effect of each action without a separate observation step.

~50% fewer tool calls. ~90% fewer tokens.

## Tools

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL. Returns a snapshot of interactive elements. |
| `browser_snapshot` | Take a snapshot of the current page. Returns interactive elements with `@e` refs. |
| `browser_click` | Click an element by ref. Returns consequences. |
| `browser_fill` | Fill a text input by ref. Returns consequences. |
| `browser_press_key` | Press a key or key combination (e.g. `Enter`, `Control+a`). Returns consequences. |
| `browser_scroll` | Scroll the viewport or a container. Detects DOM churn and layout shifts. |
| `browser_wait_for` | Wait for text to appear or a ref to become visible. Polls every 500ms. |

## Refs

Every interactive element gets a globally unique ref like `@e1`, `@e5`, `@e23`. Refs are stable across actions — use them to target clicks, fills, and scrolls. When an element leaves the DOM, its ref is never reused.

Refs resolve through a 3-tier system: backendNodeId (fast) → CSS domPath (fallback) → `REF_STALE` error.

## Consequences

Every action returns what changed:

- **appeared** — new interactive elements in the DOM
- **disappeared** — elements that left the DOM
- **changed** — elements with modified properties (name, value, checked, etc.)
- **network** — Fetch/XHR requests triggered by the action
- **dom-churn** — remove-then-re-add pairs (e.g. React re-rendering an entire list on scroll)
- **layout-shift** — CLS events without recent user input

## Scroll detection

`browser_scroll` detects rendering pathologies that are invisible to before/after snapshot diffing:

```
→ browser_scroll({ ref: "@e12", direction: "down", amount: "page" })

consequences: [
  { type: "dom-churn", churnCount: 36, desc: "DOM churn detected: 36 remove/re-add pairs" },
  { type: "layout-shift", cls: 0.042, shiftCount: 2, desc: "Layout shift: cls=0.042 (2 shifts)" }
]
```

## Setup

```bash
npm install
npm run build
```

## Usage

Launch Chrome automatically:

```bash
node dist/index.js
```

Connect to an existing Chrome instance:

```bash
node dist/index.js --cdp-url ws://127.0.0.1:9222/devtools/browser/...
```

### With Claude Desktop

Add to `claude_desktop_config.json`:

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

## Development

```bash
npm run dev          # watch mode build
npm test             # run tests
npm run test:watch   # watch mode tests
```

## Architecture

```
src/
├── index.ts              # CLI entrypoint, MCP server setup
├── types.ts              # All shared types and response schemas
├── cdp/
│   └── client.ts         # CDP connection (chrome-launcher + chrome-remote-interface)
├── state/
│   ├── ref-map.ts        # @e ref registry with 3-tier resolution
│   ├── snapshot.ts       # AX tree → ref assignment → compact line format
│   └── differ.ts         # Pre/post snapshot diffing → consequences
├── actions/
│   ├── interactable.ts   # Scroll-into-view + box model + center point
│   ├── stability.ts      # DOM mutation debounce + network tracking + churn detection
│   └── engine.ts         # Action orchestration (click, fill, scroll, etc.)
└── tools/
    ├── actions.ts        # MCP tool registrations for actions
    └── observation.ts    # MCP tool registrations for snapshot/wait_for
```

## License

MIT
