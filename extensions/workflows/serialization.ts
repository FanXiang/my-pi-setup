import * as fs from "node:fs";
import * as path from "node:path";

export interface SerializationOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxStringBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_NODES = 20_000;
const DEFAULT_MAX_STRING_BYTES = 64 * 1024;

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Normalize arbitrary values to inert JSON data. Cycles, bigint, non-finite
 * numbers, deep trees, throwing properties, and very large strings are all
 * represented explicitly instead of making artifact persistence fail.
 */
export function toSerializable(
  value: unknown,
  options: SerializationOptions = {},
): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
  const seen = new WeakMap<object, string>();
  let nodes = 0;

  const visit = (
    current: unknown,
    depth: number,
    location: string,
  ): unknown => {
    nodes++;
    if (nodes > maxNodes) return "[truncated: node limit]";
    if (depth > maxDepth) return "[truncated: depth limit]";
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      if (byteLength(current) <= maxStringBytes) return current;
      return `${truncateUtf8(current, maxStringBytes)}\n[truncated: string limit]`;
    }
    if (typeof current === "number") {
      return Number.isFinite(current)
        ? current
        : `[number: ${String(current)}]`;
    }
    if (typeof current === "bigint") return `${current.toString()}n`;
    if (typeof current === "undefined") return "[undefined]";
    if (typeof current === "symbol")
      return `[symbol: ${current.description ?? ""}]`;
    if (typeof current === "function")
      return `[function: ${current.name || "anonymous"}]`;
    if (typeof current !== "object") return String(current);

    const prior = seen.get(current);
    if (prior) return `[circular: ${prior}]`;
    seen.set(current, location);

    if (Array.isArray(current)) {
      return current.map((item, index) =>
        visit(item, depth + 1, `${location}[${index}]`),
      );
    }

    if (current instanceof Date) {
      return Number.isNaN(current.getTime())
        ? "[date: invalid]"
        : current.toISOString();
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        ...(current.stack
          ? { stack: truncateUtf8(current.stack, 16 * 1024) }
          : {}),
      };
    }

    const result: Record<string, unknown> = Object.create(null);
    let keys: string[];
    try {
      keys = Object.keys(current);
    } catch (error) {
      return `[unreadable object: ${error instanceof Error ? error.message : String(error)}]`;
    }
    for (const key of keys) {
      try {
        result[key] = visit(
          (current as Record<string, unknown>)[key],
          depth + 1,
          `${location}.${key}`,
        );
      } catch (error) {
        result[key] =
          `[unreadable property: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    return result;
  };

  return visit(value, 0, "$root");
}

/**
 * A plain JSON object of bounded size, depth and shape.
 *
 * Used wherever a schema arrives from outside the engine - a plan's gate, a
 * script's structured-output request. The bounds are the point: an unbounded
 * or self-referential "schema" reaches a serializer, a hash and a validator,
 * and each of those is a place where a pathological value stops being data
 * and starts being a denial of service. Prototype keys are refused for the
 * same reason they are refused in predicate paths.
 */
export function isBoundedJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 24) return false;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return true;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return current.every((item) => validate(item, depth + 1));
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    return Object.keys(current).every((key) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return false;
      }
      return validate((current as Record<string, unknown>)[key], depth + 1);
    });
  };
  return validate(value, 0);
}

/**
 * Stable JSON: object keys sorted, so two values that are equal always
 * serialize alike and therefore hash alike.
 *
 * Shared by every content-addressed key in the conductor - ledger entries,
 * blocker ids, the plan hash - because they have to agree. Two definitions of
 * "canonical" that drift apart would make a hash mean different things in
 * different files, and the failure would be silent: a cache that never hits,
 * or an approval that never matches.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 24) return '"[depth]"';
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`,
    );
  return `{${pairs.join(",")}}`;
}

/** Serialize to valid JSON no larger than the requested cap. */
export function safeStringify(
  value: unknown,
  options: SerializationOptions = {},
) {
  const maxBytes = Math.max(256, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const normalized = toSerializable(value, options);
  const serialized = JSON.stringify(normalized, null, 2) ?? "null";
  if (byteLength(serialized) <= maxBytes) return serialized;

  let previewBytes = Math.max(32, Math.floor(maxBytes / 3));
  while (previewBytes > 0) {
    const fallback = JSON.stringify(
      {
        truncated: true,
        reason: `serialized value exceeded ${maxBytes} bytes`,
        preview: truncateUtf8(serialized, previewBytes),
      },
      null,
      2,
    );
    if (byteLength(fallback) <= maxBytes) return fallback;
    previewBytes = Math.floor(previewBytes / 2);
  }
  return JSON.stringify({ truncated: true });
}

/** Durable same-directory replace: readers see either the old or new file. */
export function writeFileAtomic(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The original write error is more useful.
    }
    throw error;
  }
}
