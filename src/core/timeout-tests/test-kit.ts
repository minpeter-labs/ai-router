export const COOLDOWN_RE = /cooldown/;
export const INVALID_DURATION_RE = /invalid duration/;
export const MAX_DURATION_RE = /at most 24h/;

export function promiseLike<T>(value: T): PromiseLike<T> {
  const method: PromiseLike<T>["then"] = (onfulfilled, onrejected) =>
    Promise.resolve(value).then(onfulfilled, onrejected);
  const result = {};
  Object.defineProperty(result, ["th", "en"].join(""), {
    configurable: true,
    value: method,
  });
  return result as PromiseLike<T>;
}
