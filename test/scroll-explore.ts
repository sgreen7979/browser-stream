/**
 * Connect to existing Chrome, find scrollable containers, scroll chat area.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const CDP = require("chrome-remote-interface");

async function main() {
  const port = parseInt(process.argv[2] || "60855", 10);
  const client = await CDP({ port });
  const { Runtime, Page, DOM, Accessibility } = client;

  await Promise.all([
    Page.enable(),
    DOM.enable(),
    Runtime.enable(),
    Accessibility.enable(),
  ]);

  // Step 1: Find all scrollable containers
  console.log("=== Finding Scrollable Containers ===");
  const containers = await Runtime.evaluate({
    expression: `(() => {
      const results = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = getComputedStyle(el);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            results.push({
              tag: el.tagName,
              id: el.id,
              className: el.className?.toString().slice(0, 100),
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              scrollTop: el.scrollTop,
              textPreview: el.innerText?.slice(0, 100),
            });
          }
        }
      });
      return results;
    })()`,
    returnByValue: true,
  });

  const scrollables = containers.result.value;
  scrollables.forEach((s: any, i: number) => {
    console.log(`\n[${i}] <${s.tag}> id="${s.id}" class="${s.className}"`);
    console.log(`    scrollHeight=${s.scrollHeight} clientHeight=${s.clientHeight} scrollTop=${s.scrollTop}`);
    console.log(`    text: ${s.textPreview}`);
  });

  // Step 2: Find the main chat content container (likely the one with message content)
  // Look for the one that's tallest / most scrollable
  const chatContainer = scrollables.find((s: any) =>
    s.className?.includes('overflow') ||
    s.textPreview?.includes('Copy message') ||
    s.textPreview?.includes('Hello') ||
    s.scrollHeight > 1000
  ) || scrollables[0];

  if (!chatContainer) {
    console.log("\nNo scrollable containers found!");
    await client.close();
    return;
  }

  console.log(`\n\n=== Using container: <${chatContainer.tag}> class="${chatContainer.className?.slice(0, 60)}" ===`);

  async function getVisibleText(containerIdx: number) {
    const result = await Runtime.evaluate({
      expression: `(() => {
        const containers = [];
        document.querySelectorAll('*').forEach(el => {
          if (el.scrollHeight > el.clientHeight + 10) {
            const style = getComputedStyle(el);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
              containers.push(el);
            }
          }
        });
        const container = containers[${containerIdx}];
        if (!container) return [];

        const rect = container.getBoundingClientRect();
        const items = [];
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const text = node.textContent.trim();
            if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
            const elRect = node.parentElement?.getBoundingClientRect();
            if (!elRect || elRect.height === 0) return NodeFilter.FILTER_REJECT;
            // Check if visible within the container's viewport
            if (elRect.bottom < rect.top || elRect.top > rect.bottom) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });

        const seen = new Set();
        while (walker.nextNode()) {
          const text = walker.currentNode.textContent.trim().slice(0, 200);
          if (seen.has(text.slice(0, 40))) continue;
          seen.add(text.slice(0, 40));
          const tag = walker.currentNode.parentElement?.tagName || '?';
          items.push({ tag, text });
        }
        return items.slice(0, 50);
      })()`,
      returnByValue: true,
    });
    return result.result.value;
  }

  const containerIdx = scrollables.indexOf(chatContainer);

  // Current position
  console.log("\n--- Visible now ---");
  let visible = await getVisibleText(containerIdx);
  visible.forEach((v: any) => console.log(`  [${v.tag}] ${v.text}`));

  // Scroll to bottom
  console.log("\n\n=== Scrolling container to BOTTOM ===");
  await Runtime.evaluate({
    expression: `(() => {
      const containers = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = getComputedStyle(el);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            containers.push(el);
          }
        }
      });
      const c = containers[${containerIdx}];
      if (c) { c.scrollTop = c.scrollHeight; return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight }; }
      return null;
    })()`,
    returnByValue: true,
  });
  await new Promise(r => setTimeout(r, 1000));

  console.log("--- Visible at BOTTOM ---");
  visible = await getVisibleText(containerIdx);
  visible.forEach((v: any) => console.log(`  [${v.tag}] ${v.text}`));

  // Scroll to top
  console.log("\n\n=== Scrolling container to TOP ===");
  await Runtime.evaluate({
    expression: `(() => {
      const containers = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = getComputedStyle(el);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            containers.push(el);
          }
        }
      });
      const c = containers[${containerIdx}];
      if (c) { c.scrollTop = 0; return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight }; }
      return null;
    })()`,
    returnByValue: true,
  });
  await new Promise(r => setTimeout(r, 1000));

  console.log("--- Visible at TOP ---");
  visible = await getVisibleText(containerIdx);
  visible.forEach((v: any) => console.log(`  [${v.tag}] ${v.text}`));

  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
