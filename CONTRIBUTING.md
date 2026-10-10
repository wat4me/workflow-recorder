# Contributing

## Requirements

- Node.js 20 or newer
- npm
- Chromium installed for integration tests

## Checks

```bash
npm ci
npm run check
npm test
npm run package
```

Run the browser test when changing recording, tab tracking, screenshots, or UI lifecycle behavior:

```bash
npx playwright install chromium --no-shell
npm run test:integration
```

Do not edit generated files under `dist/` manually. Recreate them with `npm run package`.

## Source Layout

Keep runtime code in the existing `background/`, `content/`, `shared/`, and `ui/` directories. Add tests under `test/` for isolated behavior and extend `e2e/lifecycle.spec.js` only for behavior requiring a real Chromium extension context.
