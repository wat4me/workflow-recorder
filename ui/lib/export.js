/**
 * ZIP export of recorded workflows.
 *
 * An export is one folder per workflow containing the Markdown document and a
 * screenshots/ directory, so a batch export of several cases stays navigable
 * after unzipping.
 *
 * There is no downloads permission: the archive is handed to the page as an
 * object URL and a synthetic anchor click, which puts the file wherever the
 * user's browser is configured to put downloads.
 */
(function () {
  if (globalThis.RecorderExport) return;

  const { t } = globalThis.RecorderI18n;

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();

    setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Makes a user-supplied case name safe as a filename on every platform we can
   * be downloaded to, including the reserved Windows device names.
   */
  function sanitizeExportName(name) {
    const fallback = "recorded-workflow";
    let normalized = String(name || "").trim()
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/-+/g, "-")
      .replace(/\.(?:swrcase|zip|md|json)$/i, "")
      .slice(0, 120)
      .replace(/[. ]+$/g, "");

    if (!normalized || normalized === "." || normalized === "..") return fallback;
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized)) {
      normalized = `${normalized}-export`;
    }
    return normalized;
  }

  async function addWorkflowFolder(writer, workflow) {
    const actions = workflow.actions || [];
    if (actions.length === 0) return;

    const baseName = sanitizeExportName(workflow.name);
    const folder = `${baseName}/`;
    const doc = globalThis.StepDocGenerator
      ? globalThis.StepDocGenerator.generate(actions)
      : "No steps recorded yet.";

    const screenshotLines = [];
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      const type = String(action.type || "step").replace(/[^a-z0-9_-]/gi, "-");
      const stepStem = `step-${String(index + 1).padStart(3, "0")}-${type}`;
      const frames = [
        { key: action.screenshotBeforeKey, label: "before", suffix: "before", highlight: action.screenshotBeforeHighlight },
        { key: action.screenshotKey, label: "after", suffix: "after" }
      ];

      for (const frame of frames) {
        if (!frame.key) continue;
        const screenshot = await globalThis.RecorderBridge.getBlob(frame.key);
        if (!screenshot) continue;

        const relativeFilename = `screenshots/${stepStem}-${frame.suffix}.jpg`;
        const rendered = frame.highlight
          ? await globalThis.RecorderScreenshotMedia.addTargetHighlight(screenshot, frame.highlight)
          : screenshot;
        await writer.add(`${folder}${relativeFilename}`, rendered);
        screenshotLines.push(`- Step ${index + 1} ${frame.label}: ${relativeFilename}`);
      }
    }

    // Appended only once the filenames are known, so the index cannot list a
    // screenshot that failed to read.
    const document = screenshotLines.length > 0
      ? `${doc.trimEnd()}\n\n## Step screenshots\n\n${screenshotLines.join("\n")}\n` : doc;
    await writer.add(`${folder}${baseName}.md`, globalThis.fflate.strToU8(document), true);
  }

  async function exportWorkflow(actions, exportName) {
    if (!actions || actions.length === 0) return;

    const baseName = sanitizeExportName(exportName);
    const writer = globalThis.RecorderArchiveStream.createWriter();
    try {
      await addWorkflowFolder(writer, { name: baseName, actions });
      triggerDownload(writer.finish(), `${baseName}.zip`);
    } catch (error) { writer.abort(); throw error; }
  }

  async function exportWorkflowBatch(workflows, archiveName = t("batchCaseArchive", [], "批量用例")) {
    const validWorkflows = (workflows || []).filter(workflow => workflow?.actions?.length);
    if (validWorkflows.length === 0) return;

    const writer = globalThis.RecorderArchiveStream.createWriter();
    // Two cases may carry the same name; suffix duplicates so neither folder
    // silently overwrites the other inside the archive.
    const usedNames = new Map();
    try {
      for (const workflow of validWorkflows) {
        const rawName = sanitizeExportName(workflow.name);
        const count = (usedNames.get(rawName) || 0) + 1;
        usedNames.set(rawName, count);
        const uniqueName = count === 1 ? rawName : `${rawName}-${count}`;
        await addWorkflowFolder(writer, { ...workflow, name: uniqueName });
      }

      triggerDownload(
        writer.finish(),
        `${sanitizeExportName(archiveName)}.zip`
      );
    } catch (error) { writer.abort(); throw error; }
  }

  globalThis.RecorderExport = {
    exportWorkflow,
    exportWorkflowBatch,
    sanitizeExportName,
    triggerDownload
  };
})();
