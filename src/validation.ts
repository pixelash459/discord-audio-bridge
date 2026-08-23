import type { SourceSpec } from './voice/session.ts';

export const OPUS_MIN_BITRATE = 8_000;
export const OPUS_MAX_BITRATE = 510_000;

function shortText(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (!text || text.length > max || /[\0\r\n]/.test(text)) {
    throw new Error(`${field} is empty or invalid.`);
  }
  return text;
}

/** Validate the complete discriminated union before any value reaches a capture subprocess. */
export function validateSource(value: unknown): SourceSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A valid capture source is required.');
  }
  const source = value as Record<string, unknown>;
  if (source['kind'] === 'process') {
    const pid = source['pid'];
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || Number(pid) > 0xffff_ffff) {
      throw new Error('The application source has an invalid process or node ID.');
    }
    return {
      kind: 'process',
      pid: Number(pid),
      label: shortText(source['label'] ?? `Process ${pid}`, 'Source label', 256),
      exclude: source['exclude'] === true,
    };
  }
  if (source['kind'] === 'device') {
    const id = shortText(source['id'], 'Device ID', 2_048);
    return { kind: 'device', id, label: shortText(source['label'] ?? id, 'Source label', 256) };
  }
  if (source['kind'] === 'dshow') {
    const name = shortText(source['name'], 'DirectShow device name', 1_024);
    return { kind: 'dshow', name, label: shortText(source['label'] ?? name, 'Source label', 256) };
  }
  throw new Error('Unknown capture source type. Refresh the source list and try again.');
}

export function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
  return value;
}
