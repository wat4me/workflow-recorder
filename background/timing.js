/** Promise-based delay. Shared so retry/backoff loops do not each re-declare it. */
export function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
