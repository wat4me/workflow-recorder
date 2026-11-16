/** Localizes recorder-generated tab handles and preserves custom names. */
export function recordingTabLabel(pageName) {
  const number = /^page(\d+)$/.exec(pageName)?.[1];
  return number ? globalThis.RecorderI18n.t("recordingTabNumber", [number], `标签页 ${number}`) : pageName;
}
