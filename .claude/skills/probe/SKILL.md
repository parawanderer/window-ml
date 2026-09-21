---
name: probe
description: Look at a page once from the command line — a URL or a built file (dist-web/, dist-app/, dist-native/) at phone or desktop size, with touch, dark mode or WebKit — evaluate an expression in it, and get its errors and a screenshot. Use to answer "what is on screen and why" instead of writing a throwaway Playwright spec.
---

# probe

```bash
node scripts/probe.mjs dist-web/index.html                                   # desktop, screenshot + errors
node scripts/probe.mjs dist-web/index.html#/settings/devices --phone --touch --dark
node scripts/probe.mjs dist-native/embed-demo.html --phone --wait 1500 \
    --eval '(() => { __wmlReceive(JSON.stringify({v:1,type:"open",key:"laptop:7b21d4e8"})); return 1; })()'
node scripts/probe.mjs http://127.0.0.1:5173/ --size 1280x800 --webkit --shot /tmp/x.png --full
```

- A file path is served over HTTP from its directory (IndexedDB and WebCrypto need a real origin); `#…`/`?…` after
  it are kept.
- `--wait` is milliseconds or a CSS selector (15 s cap). `--eval` is an EXPRESSION, printed as JSON; wrap statements
  in an IIFE. `--before '<js>'` is an init script that runs before the page's own (stub a global, set a flag).
- Prints `pageerror:` lines and console errors and warnings; exits 1 on a page error unless `--allow-errors`.
- The screenshot defaults to `test-results/probe.png`: Read it to see the page.
- `--webkit` is Safari's engine (the iOS app's WebView is WebKit): the quickest check that something works there.
  Install once with `npx playwright install webkit`.

When the question turns into something that must stay true, write a spec instead: a probe answers once.
