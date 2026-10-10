# Architecture

## Runtime

The extension is a Chrome Manifest V3 application. The top-level directories map to
execution contexts, because that is the boundary Chrome enforces: the Service
Worker, recorded pages, and extension pages share no scope and cannot import
across the divide. Responsibility-based subdirectories live inside each one.

- `background/`: the module Service Worker. `main.js` builds modules and wires
  dependencies; `routes.js` owns the application message boundary and
  `browser-events.js` owns Chrome listener registration. Behaviour lives in
  `store/`, `capture/`, `recording/`, and `agent/`.
- `content/`: scripts running in recorded pages and frames. They observe browser
  events, analyze targets, detect page stability, prime screencast frames when
  needed, and report structured actions. None are declared in
  `manifest.content_scripts`; they are injected programmatically once the user
  invokes the extension.
- `ui/`: the side-panel recorder and fullscreen case workbench. Each page has one
  ES-module entry point (`popup-entry.js` or `console-entry.js`); `app/` holds view
  controllers, `lib/` holds single-purpose services, and `styles/` is split by
  component or view responsibility.
- `shared/`: context-agnostic utilities. `protocol.js` is the single vocabulary
  for runtime messages and Agent states, `i18n.js` runs in all three contexts,
  and `media-store.js` runs in the worker and extension pages.

### Dependency direction

HTML pages load one module entry instead of maintaining an ordered list of
scripts. The entries make the current legacy-global dependency order explicit in
JavaScript, which keeps page markup independent of internal module layout and
provides a gradual path to named ES-module exports.

In `background/`, `store/` and `capture/` never reach upward into `recording/`.
Cross-module wiring is passed in as constructor arguments from `main.js` rather
than imported, which is what keeps the modules independently readable. The one
direct import across those directories is `recording/action-log.js` reaching down
into `capture/screenshot-status.js`: the capture state a step is created with has
to be the same shape the capture pipeline later writes, and passing that through
`main.js` as a function argument would hide the fact that they are one vocabulary.

## Recording Flow

1. The UI sends `toggleRecording` to the Service Worker.
2. `recording/session.js` admits the root tab through `recording/scope.js`,
   injects the content scripts, verifies `pingRecorder`, and starts a CDP screencast.
3. Content scripts send action messages for the admitted tab tree only.
4. The Service Worker serializes action writes through the action queue
   (`queue.js`). Child-tab registration uses a separate queue so a fast-loading
   child page does not wait behind the parent click's 1.2s validation.
5. When an action arrives, its current cached frame is retained as
   `screenshotBeforeKey`. The screenshot job then waits for page stability and
   stores the resulting frame as `screenshotKey`. Both keys belong to the same
   step, so the UI and export can present the change as **before → after** without
   doubling the workflow's step count.
6. The UI observes storage/message updates and renders the current workflow.

Only a fresh recording's root page produces a lifecycle step. Later document
loads still trigger `webNavigation` so the recorder can be re-injected, but they
start with navigation reporting disabled. Redirects, reloads, login transitions
and child-page opens therefore do not become standalone `navigate` or `newPage`
steps. A user click that caused the transition remains the semantic action, and
its before/after frames describe the result.

`Page.startScreencast` deliberately omits its optional `maxWidth` and `maxHeight`.
Chromium then keeps the page surface's native viewport resolution instead of
downscaling every large window to a recorder-owned fixed size; because no target
dimensions are baked into the session, later window resizes are reflected too.

### Capture state

Each step carries its own capture state — `pending`, `captured`, `skipped` or
`failed` — and the shared `screenshotCaptureState` carries which step is
capturing right now. The eight states a card can show are derived from those two
plus whether the step has a screenshot (see `ui/lib/capture-state.js`), so a
"captured, re-capture in progress" step is `pending` *with* a key rather than a
fifth stored value that can contradict the first four.

Two consequences are worth stating outright:

A step that has a screenshot is never rendered as unavailable. A failed
re-capture keeps the image it already has and says so, because the alternative is
blanking a card that has a perfectly good screenshot.

Every capture writes a new key. The key used to be `screenshot:<actionId>`,
overwritten in place, which is only safe while an action id has one owner — and
loading a case puts its steps, ids and screenshot keys included, straight into the
workspace. Re-capturing there rewrote the saved case's screenshot. The previous
key is offered for collection only after the step points at the new blob, and only
through the reference-aware path, so a key another record still uses survives.

A recording holds the worker open for its duration. Each recorded tab's top frame
connects a `recording-keepalive` port; accepting it is the worker's whole part,
because an open port is what defers termination. Without it a user who clicks once
and then reads the page for thirty seconds produces no events at all — a screencast
only pushes on paint — and the worker is collected along with the capture queue and
every CDP session. The hold is released on the `stopRecording` message *and* on the
`isRecording` storage flag, because a backgrounded tab may never receive the
message; a dropped port reconnects while recording still applies, and since the
retry is only ever scheduled from a disconnect, a removed extension stops instead
of spinning.

The pending marker is folded into the write that creates or changes the step. The
step store was restructured so that recording a step costs one storage write, and
a separate "now waiting for a screenshot" patch would give that back. A manual
capture from the side panel is the one exception: its target already exists, so
there is no action-creation write to fold into.

`pending` is also the state a terminated worker leaves behind. The queue and the
CDP sessions live in worker memory, so those steps have no capture coming and
cannot be retried honestly — the page has moved on. Startup fails them explicitly
with a reason the panel can show, skipping any step the new worker has already
claimed, and the user can re-capture manually.

The manual screenshot control belongs to the side panel. Recorded pages receive
no visible screenshot button; they only expose a short-lived frame-primer helper
that creates one clean paint when a static page has not produced a screencast
frame. The side panel sends the active tab id and the worker verifies that it is
inside the recording scope before binding the frame to that page's latest step.

### Session teardown

Stopping is ordered and the order is forced: queued action writes must land
before pending screenshots can bind to them, and both need the CDP screencast
still attached. Chrome shows its "started debugging this browser" infobar for
exactly as long as that screencast is attached, so anything the teardown waits on
is time the user spends looking at a debugging banner for a recording they already
stopped.

`createScreenshotManager` therefore has a `finishing` mode, entered by `flush()`,
in which the pump never waits: no settle delay, no page-stability wait, no retry,
no progress broadcasts, and frames come from the cache instead of a fresh paint.
Pending steps still get a screenshot; they just get the frame already in hand.
`flush()` also cancels the stability wait of whichever job was mid-flight when the
user pressed stop, since that job is already past the `finishing` checks.

The bound is asserted in `e2e/lifecycle.spec.js`, at the point in the run that
deliberately builds a screenshot backlog.

## Storage

- `chrome.storage.local`: recording state, actions, tab/page mapping, and saved cases.
- IndexedDB database `PlaywrightRecorderDB`, object store `blobs`: screenshot Blob values keyed by screenshot key.

### Saved cases

Cases are split by access pattern rather than kept in one array, because listing
the history, saving one case, and deciding which screenshots are still referenced
are three operations with three different appetites for the data:

| Key | Content | Read by |
| --- | --- | --- |
| `caseIndex` | metadata only: id, name, `createdAt`, `stepCount`, `readable`, ordered newest first | every list and summary query |
| `case:<id>` | that case's `actions` and `pages` | loading, previewing and exporting one case |
| `caseMedia:<id>` | that case's deduplicated screenshot keys | media cleanup |

The screenshot keys are deliberately *not* in `caseIndex`: they scale with step
count, so folding them in would put the whole history's key list on the path of
every history query — the cost the split exists to remove.

Saving writes the index entry, the detail record and the media list in one
`set()`, so a case can never be listed without its steps being readable.
Portable-package import extends the same rule to a whole selected family:
`writeCases()` commits every imported index/detail/media record in one storage
write. The UI stages remapped image blobs first and deletes them again if that
commit fails, so neither half a family nor unreferenced imported media remains.
Deleting cannot be atomic — `set` and `remove` are separate operations — so the
index is committed first and the id is parked in `pendingCaseRecordRemovalIds`;
an interruption therefore leaves records nothing references rather than an index
entry pointing at steps that are gone, and worker startup finishes the job.

`listCases` returns metadata only. Anything that needs steps asks for one case at
a time through `getCaseDetails`, which is what keeps a batch export's peak memory
at a single case instead of the whole selection.

Case mutations are serialized through their own queue. They all read the index,
change it and write it back, so two in flight at once can drop one another's
entry — a saved case silently missing from the history. The queue is separate from
the action queue so that banking a large case does not delay the screenshot
binding of the step being recorded.

### Lineage

Loading a case and continuing to record produces a new case that shares a prefix
with the one it started from. `store/workspace-origin.js` records that:

`workspaceOrigin` holds the case the workspace was loaded from, its name at the
time, and a fingerprint per inherited step. Saving turns that into a `lineage`
object on the new case's index entry — parent id, parent name snapshot, fork point,
inherited step count, and whether the relationship is a `continued` or a
`modified` one. A case with no lineage is a root.

Three decisions are load-bearing:

*The comparison is against a snapshot, not against the parent.* Working out how
much of a case was inherited by reading the parent's steps would stop working the
moment the parent is deleted, and deleting it while an unsaved derived workspace is
open is allowed. The snapshot needs the parent only at load time; afterwards the
origin becomes a tombstone and the name snapshot keeps the relationship
explainable.

*The origin survives recording.* `activeCaseId` is cleared on the first new step,
because it means "the workspace matches a saved case" and that stops being true.
The origin means something else and must not be cleared there — continuing is
exactly when the relationship is being created. Only a deliberate clear drops it:
a new case, a restarted recording, or deleting the loaded case itself.

*Editing an inherited step copies it first.* An inherited step keeps its original
action id — that is what marks it as shared. Merging keystrokes into it is the one
path that changes a recorded step's meaning after the fact, so the workspace copy
takes a fresh id and an `originActionId` back-reference. Both halves of the fork
comparison then matter: the id catches a removed or reordered step, and the
signature (`store/step-signature.js`) catches one that kept its id while its
meaning changed. The second case is supposed to be impossible, which is the point
— it is the check that would notice a future edit path forgetting to copy.

A signature covers what a step means: the action, its page, how the element is
located, and the payload the user supplied. It excludes timing, screenshot keys and
capture state, so re-capturing a screenshot does not make a step look edited. The
origin stores 32-bit fingerprints rather than the signatures themselves, because it
is rewritten on every load and full signatures include DOM paths.

## Console views

The fullscreen workbench contains the saved-case library and a read-only step
preview. It keeps search, folders, import/export, and sharing. The preview reuses
`RecorderStepView` and can load a complete case into the side panel for continued
recording after a target tab is chosen. Existing scene records are read as ordinary
saved steps; their stored provenance remains available for compatibility.

The `hidden` attribute needs an explicit `[hidden] { display: none }` rule on
panels because author display declarations override the browser default.

### Schema versions

`schemaVersion` is owned by `store/case-migration.js` and written nowhere else —
in particular not by the install handler, which runs before anything has looked at
the stored layout and would otherwise erase the signal a v1 profile is recognised
by. Every case route waits on that coordinator first, which removes
"half migrated" as a state any caller has to handle.

The v1 → v2 conversion is resumable: detail and media records are written in
idempotent batches keyed by case id, the index and version are committed in a
single write, and the v1 array is deleted only after that commit has been read
back. A failed attempt keeps the v1 data, keeps serving reads from it, and refuses
case writes until a later worker start succeeds.

### Screenshot cleanup

When an action or case is deleted, its screenshot keys are removed only when no current action or saved case still references them. This prevents a saved case from losing media shared by a workspace action. The reference set is assembled from the open workspace steps plus the `caseMedia:<id>` lists, never from the cases' steps, so deleting one step costs a few small reads instead of deserializing the entire history.

Failed deletions are persisted in `pendingScreenshotDeleteKeys`. Service Worker startup performs a throttled orphan scan and retries unreferenced keys; normal scans are skipped while recording is active.

## Packaging

`npm run package` validates all manifest file references, recreates `dist/`, copies only extension runtime files, writes a ZIP, and emits `dist/package-manifest.json`. Tests and development files are intentionally excluded.

It also validates the `INJECTION_BATCHES` list in
`background/recording/injection.js`. Programmatically injected scripts are
invisible to the manifest, so without this check a renamed content script would
package cleanly and fail only at record time, inside a tab the user is already
trying to record.
