import { join, isAbsolute } from 'path';

/** True when the value satisfies a JSON-Schema primitive type name. */
export function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (type === 'number' || Number.isInteger(value))
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true; // unknown type keyword: don't over-reject
  }
}

/**
 * Shared helpers for built-in tools: path resolution against the working
 * directory and the default directory-ignore list used by content-scanning
 * tools (glob, grep, find, search).
 *
 * v1 perf lesson: without these ignores a grep over a project tree walked
 * node_modules and took 15.7s instead of 0.12s. They are non-negotiable.
 */

/** Glob patterns for directories that scanning tools must skip by default. */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/tmp/**',
];

/** The same directories as bare names, for manual walk pruning. */
export const IGNORED_DIR_NAMES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  'tmp',
];

/**
 * Resolve a user-supplied path against the tool context working directory.
 * Absolute paths pass through untouched; everything else is joined.
 */
export function resolvePath(workingDirectory: string, inputPath: string): string {
  if (isAbsolute(inputPath)) {
    return inputPath;
  }
  return join(workingDirectory, inputPath);
}

/** True if the final path segment is one of the default-ignored dir names. */
export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIR_NAMES.includes(name);
}

/** Read a string input field, throwing a descriptive error when missing. */
export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing or invalid required input: ${key}`);
  }
  return value;
}

/** Read an optional string input field (undefined when absent). */
export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read an optional boolean input field (fallback when absent). */
export function optionalBool(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** Read an optional number input field (fallback when absent). */
export function optionalNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Coerce unknown tool input to a record; throws when not an object. */
export function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Tool input must be an object');
  }
  return input as Record<string, unknown>;
}

/** Normalize any thrown value into an error message string. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
