const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function isValidHttpHeaderName(value: string): boolean {
  return value.length <= 256 && HTTP_HEADER_NAME_PATTERN.test(value);
}

export function hasInvalidHttpHeaderValueCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 10 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

export function boundedEnumerableOwnKeys(
  value: object,
  maximum: number
): string[] | undefined {
  const keys: string[] = [];
  let visited = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      visited += 1;
      if (visited > maximum) {
        return;
      }
      keys.push(key);
    } else {
      visited += 1;
      if (visited > maximum) {
        return;
      }
    }
  }
  return keys;
}
