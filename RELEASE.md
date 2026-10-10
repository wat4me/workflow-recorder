# Release

## 1.2.1

- Continuing a paused recording re-adopts the tabs and windows the session already covered, so actions taken in a window opened earlier are recorded again instead of being dropped.
- Element snapshots no longer treat password fields differently: values are recorded as entered, matching the in-product recording disclosure.
- Drop the leftover masked-value handling from saved-case signatures.

## 1.2.0

- Refine the light-theme recorder controls, step alignment and responsive download actions.
- Add screenshot navigation, complete title tooltips and mouse panning after zooming.
- Add collapsible folder trees, folder renaming and subtree moves by menu or drag and drop.
- Clarify document export versus shareable case packages; keep AI copy instructions tool-neutral.
- Keep Bridge and execution-record implementations but hide their entry points in this release.
- Guard manual screenshot page binding and bound the repaint wait before capture.
- Continue importing case packages exported before the project rename.

## Pre-release Checklist

1. Replace all placeholders in `docs/PRIVACY_POLICY.md`.
2. Review the permissions in `manifest.json`.
3. Run `npm ci`, `npm run check`, `npm test`, and `npm run test:integration`.
4. Run `npm run package`.
5. Inspect `dist/package-manifest.json` and the generated ZIP contents.
6. Load `dist/workflow-recorder-<version>/` as an unpacked extension and smoke-test recording, child tabs, screenshots, deletion, and export.

The `dist/` directory is generated output and is ignored by Git. The source tree and the packaging script are the release source of truth.
