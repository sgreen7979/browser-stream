/**
 * Manual drive — find chat items in the DOM and complete the full flow
 */
import { connect, disconnect, getClient } from "../src/cdp/client.js";
import { navigate, click } from "../src/actions/engine.js";
import { takeSnapshot, snapshotDataToResult } from "../src/state/snapshot.js";
import { resetCounter } from "../src/state/ref-map.js";

async function snap() {
  const cdp = getClient();
  const data = await takeSnapshot(cdp);
  return snapshotDataToResult(data, 0);
}

async function pause(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await connect();
  resetCounter();

  // Navigate and sign in
  console.log(">>> Navigate and sign in...");
  await navigate("http://localhost:3010");
  await pause(3000);
  let page = await snap();
  const bypassLine = page.elements.find((l) => l.toLowerCase().includes("preview bypass"));
  if (bypassLine) {
    await click(bypassLine.split(" ")[0]);
    await pause(3000);
  }

  // Search the DOM for "Sleep for 20 Secs" to understand the element structure
  console.log("\n>>> Searching DOM for 'Sleep for 20 Secs'...");
  const cdp = getClient();

  const searchResult = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        // Walk all text nodes to find the one containing the target text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        const matches = [];
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.includes('Sleep for 20')) {
            const el = walker.currentNode.parentElement;
            // Walk up to find the clickable ancestor
            let ancestor = el;
            const chain = [];
            for (let i = 0; i < 8 && ancestor && ancestor !== document.body; i++) {
              chain.push({
                tag: ancestor.tagName,
                role: ancestor.getAttribute('role'),
                className: ancestor.className?.toString().slice(0, 80),
                onclick: !!ancestor.onclick,
                tabIndex: ancestor.tabIndex,
                cursor: getComputedStyle(ancestor).cursor,
              });
              ancestor = ancestor.parentElement;
            }
            matches.push({
              text: el.textContent.slice(0, 100),
              elementTag: el.tagName,
              chain,
            });
          }
        }
        return matches;
      })()
    `,
    returnByValue: true,
  });

  console.log("Found:", JSON.stringify(searchResult.result.value, null, 2));

  // Now try to click the element directly via CDP
  console.log("\n>>> Finding clickable chat item...");
  const clickTarget = await cdp.send("Runtime.evaluate", {
    expression: `
      (() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.includes('Sleep for 20')) {
            // Walk up to find the element with cursor:pointer
            let el = walker.currentNode.parentElement;
            for (let i = 0; i < 10 && el && el !== document.body; i++) {
              if (getComputedStyle(el).cursor === 'pointer') {
                return {
                  found: true,
                  tag: el.tagName,
                  text: el.innerText?.slice(0, 100),
                  rect: el.getBoundingClientRect().toJSON(),
                };
              }
              el = el.parentElement;
            }
            return { found: false, msg: 'No cursor:pointer ancestor' };
          }
        }
        return { found: false, msg: 'Text not found' };
      })()
    `,
    returnByValue: true,
  });

  console.log("Click target:", JSON.stringify(clickTarget.result.value, null, 2));

  if (clickTarget.result.value?.found) {
    const rect = clickTarget.result.value.rect;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    console.log(`\n>>> Clicking at center (${x}, ${y})...`);

    // Take pre-snapshot manually
    const preData = await takeSnapshot(cdp, { keepExistingRefs: true });
    const pre = snapshotDataToResult(preData, 0);

    // Click directly via Input.dispatchMouseEvent
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

    await pause(3000);
    const postData = await takeSnapshot(cdp);
    const post = snapshotDataToResult(postData, 0);

    console.log("\n=== After clicking chat ===");
    console.log("Page:", JSON.stringify(post.page));
    console.log("Elements:", post.elements.length);
    post.elements.forEach((e) => console.log("  ", e));
  }

  console.log("\n>>> Done. Browser is still open. Press Ctrl+C to close.");
  await new Promise(() => {}); // Keep alive
}

main().catch((e) => { console.error(e); process.exit(1); });

process.on("SIGINT", async () => {
  console.log("\n>>> Closing browser...");
  await disconnect();
  process.exit(0);
});
