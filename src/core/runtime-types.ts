const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag
)?.get;

/** Consume a native Promise without consulting arbitrary `then` properties. */
export function consumeGenuinePromise(value: unknown): boolean {
  if (
    !(
      (typeof value === "object" && value !== null) ||
      typeof value === "function"
    )
  ) {
    return false;
  }
  try {
    const chained = Promise.prototype.then.call(
      value,
      () => undefined,
      () => undefined
    );
    Promise.prototype.then.call(
      chained,
      () => undefined,
      () => undefined
    );
    return true;
  } catch {
    return false;
  }
}

/** Consume Promise-valued own data fields without invoking accessors. */
export function consumeOwnDataPromiseFields(
  value: object,
  keys: readonly (string | number)[]
): void {
  for (const key of keys) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        consumeGenuinePromise(descriptor.value);
      }
    } catch {
      // A malformed Proxy field cannot prevent checks of later bounded keys.
    }
  }
}

/** Capture a native/cross-realm Promise without consulting a `then` property. */
export function captureGenuinePromise<T>(
  value: unknown
): Promise<T> | undefined {
  let genuine = true;
  const captured = new Promise<T>((resolve, reject) => {
    try {
      Promise.prototype.then.call(value, resolve, reject);
    } catch {
      genuine = false;
    }
  });
  return genuine ? captured : undefined;
}

/** Require a genuine Promise and map brand failures without reading `then`. */
export function requireGenuinePromise<T>(
  value: unknown,
  errorFactory: (cause: unknown) => unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      Promise.prototype.then.call(value, resolve, reject);
    } catch (error) {
      reject(errorFactory(error));
    }
  });
}

/** Cross-realm-safe Uint8Array check for provider file payloads. */
export function isUint8ArrayValue(value: unknown): value is Uint8Array {
  if (typedArrayTagGetter === undefined) {
    return false;
  }
  try {
    return (
      ArrayBuffer.isView(value) &&
      Reflect.apply(typedArrayTagGetter, value, []) === "Uint8Array"
    );
  } catch {
    return false;
  }
}

/** Cross-realm-safe URL check using the platform URL brand operation. */
export function isUrlValue(value: unknown): value is URL {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    URL.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

/** Cross-realm-safe finite Date check using the Date internal slot. */
export function isDateValue(value: unknown): value is Date {
  try {
    return Number.isFinite(Date.prototype.getTime.call(value));
  } catch {
    return false;
  }
}

/** Accept ordinary records across realms while rejecting class/runtime containers. */
export function isPlainObjectValue<T>(
  value: T
): value is T & Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  } catch {
    return false;
  }
}

/** Validate template-literal identifiers shaped as `<namespace>.<name>`. */
export function isDottedIdentifier(
  value: unknown
): value is `${string}.${string}` {
  return (
    isBoundedIdentifier(value) && value.indexOf(".") > 0 && !value.endsWith(".")
  );
}

/** Bound opaque IDs used in maps/sets while rejecting ambiguous empty IDs. */
export function isBoundedIdentifier(
  value: unknown,
  maximum = 4096
): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

/** Array check that rejects holes skipped by every/map and inherited indexes. */
export function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      return false;
    }
  }
  return true;
}
