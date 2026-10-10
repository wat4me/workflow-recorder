export function nextScreenshotKey(actionId) {
  const captureId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `screenshot:${actionId}:${captureId}`;
}

export function beforeScreenshotKey(actionId) {
  const captureId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `screenshot:${actionId}:b${captureId}`;
}
