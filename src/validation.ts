import type { SourceSpec } from './voice/session.ts';

export const OPUS_MIN_BITRATE = 8_000;
export const OPUS_MAX_BITRATE = 510_000;

/** Mixing more than a handful of taps is a CPU and clock-sync problem, not a feature. */
export const MAX_MIX_INPUTS = 4;

function shortText(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (!text || text.length > max || /[\0\r\n]/.test(text)) {
    throw new Error(`${field} is empty or invalid.`);
  }
  return text;
}

function optionalShortText(value: unknown, field: string, max = 512): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return shortText(value, field, max);
}

/** Per-input trim inside a mix. Absent means unity. */
function optionalGain(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return finiteNumber(value, field, -60, 20);
}

/** Validate the complete discriminated union before any value reaches a capture subprocess. */
export function validateSource(value: unknown): SourceSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A valid capture source is required.');
  }
  const source = value as Record<string, unknown>;
  const gainDb = optionalGain(source['gainDb'], 'Source gain');

  if (source['kind'] === 'process') {
    const pid = source['pid'];
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || Number(pid) > 0xffff_ffff) {
      throw new Error('The application source has an invalid process or node ID.');
    }
    return {
      kind: 'process',
      pid: Number(pid),
      // Kept so a restarted app can be found again: the PID dies with the process, the name does not.
      processName: optionalShortText(source['processName'], 'Process name', 256),
      label: shortText(source['label'] ?? `Process ${pid}`, 'Source label', 256),
      exclude: source['exclude'] === true,
      ...(gainDb === undefined ? {} : { gainDb }),
    };
  }
  if (source['kind'] === 'device') {
    const id = shortText(source['id'], 'Device ID', 2_048);
    return {
      kind: 'device',
      id,
      label: shortText(source['label'] ?? id, 'Source label', 256),
      ...(gainDb === undefined ? {} : { gainDb }),
    };
  }
  if (source['kind'] === 'dshow') {
    const name = shortText(source['name'], 'DirectShow device name', 1_024);
    return {
      kind: 'dshow',
      name,
      label: shortText(source['label'] ?? name, 'Source label', 256),
      ...(gainDb === undefined ? {} : { gainDb }),
    };
  }
  throw new Error('Unknown capture source type. Refresh the source list and try again.');
}

/**
 * Accepts either the single-source shape the API has always taken or the newer `sources` array.
 *
 * Only tap-backed sources can be mixed: a DirectShow input is consumed by ffmpeg directly and never
 * passes through the summing stage, so it can only ever be alone.
 */
export function validateSources(input: { source?: unknown; sources?: unknown }): SourceSpec[] {
  const raw = Array.isArray(input.sources) ? input.sources : [input.source];
  if (raw.length === 0) throw new Error('A valid capture source is required.');
  if (raw.length > MAX_MIX_INPUTS) {
    throw new Error(`At most ${MAX_MIX_INPUTS} sources can be mixed together.`);
  }

  const sources = raw.map((value) => validateSource(value));

  if (sources.length > 1) {
    if (sources.some((source) => source.kind === 'dshow')) {
      throw new Error('A DirectShow input cannot be mixed with anything else. Capture it on its own.');
    }
    const keys = sources.map((source) =>
      source.kind === 'process' ? `p${source.pid}` : source.kind === 'device' ? `d${source.id}` : `s${source.label}`,
    );
    if (new Set(keys).size !== keys.length) {
      throw new Error('The same source is listed more than once.');
    }
  }

  return sources;
}

export function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
  return value;
}
