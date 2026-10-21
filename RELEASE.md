# Release

## 1.3.1

- Keep unsaved recordings in the background, show recovery only when multiple recordings are available, and retain up to 10 unsaved recordings.
- Improve recovery feedback and closing controls, and reconnect recording panels after back/forward cache transitions.
- Filter clicks without meaningful page effects and ignore unchanged input fields and empty editor fillers while preserving real clears and autofill.
- Let ready pages capture independently, reuse settled frames, and release the debugger before queued screenshot saves finish.
- Use compact icon controls with hover labels while retaining text for saving cases, copying for AI and clearing steps.
- Keep temporary recording diagnostics disabled in shared builds, including the export and clear controls.

## 1.3.0

- Capture browser-computed local accessibility context separately from DOM evidence and include both in AI copy and exported steps, including when screenshots are off.

- Redesign the workbench with a compact case list, nested folders, clickable breadcrumbs and consistent colors by folder level.
- Choose a folder when saving from the side panel and verify the saved classification.
- Limit case names to 120 characters and support renaming. Number duplicate names within each folder on save, import or move; reject conflicting manual renames without overwriting cases.
- Keep recording names scoped to the current workspace and restore saved names when loading cases.
- Make screenshot settings apply consistently when starting or continuing a recording; improve capture status wording.
- Protect screenshot publication and cleanup with serialization and transaction completion checks.
- Remove the unused native Bridge and execution-record implementation and its nativeMessaging permission.
- Publish under MIT and provide GitHub and privacy policy links.

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

1. Confirm the store links to the current published `docs/PRIVACY_POLICY.md` and the data disclosures match the implementation.
2. Review the permissions in `manifest.json`.
3. Run `npm ci`, `npm run check`, `npm test`, and `npm run test:integration`.
4. Run `npm run package`.
5. Inspect `dist/package-manifest.json` and the generated ZIP contents.
6. Load `dist/workflow-recorder-<version>/` as an unpacked extension and smoke-test recording, child tabs, screenshots, deletion, and export.

The `dist/` directory is generated output and is ignored by Git. The source tree and the packaging script are the release source of truth.
