const REDACTED = '<REDACTED>';
const SENSITIVE_KEY = /(?:password|secret|token|stok|cookie|authorization)/i;

export function redactSensitiveData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : redactSensitiveData(nestedValue);
  }
  return redacted as T;
}

export function redactRequestPath(path: string): string {
  return path.replace(/;stok=[^/]*(?=\/)/g, `;stok=${REDACTED}`);
}
