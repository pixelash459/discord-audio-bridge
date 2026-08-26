import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';

import { config, DISCORD_AUDIO } from '../config.ts';
import { logger } from '../logger.ts';
import { Pacer } from './pacer.ts';
import type { CaptureTap, DeviceInfo, ProcessInfo, RawFormat, TapOptions, TapStats } from './tap.ts';

const log = logger('pipewire');
let availability: { value: boolean; expires: number } | undefined;
let rawFlagSupport: { value: boolean; expires: number } | undefined;
let nodeCache: { value: PwNode[]; expires: number } | undefined;
let nodeDump: Promise<PwNode[]> | undefined;

export interface PwNode {
  id: number;
  type: string;
  state?: string;
  info?: { props?: Record<string, unknown>; state?: string };
}

const props = (node: PwNode): Record<string, unknown> => node.info?.props ?? {};
const nodeName = (node: PwNode): string => String(props(node)['node.name'] ?? '');
const nodeState = (node: PwNode): string => node.state ?? node.info?.state ?? '';

export function pipewireAvailable(): boolean {
  if (availability && availability.expires > Date.now()) return availability.value;
  const record = spawnSync(config.paths.pwRecord, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  // Unlike pw-record, pw-dump does not consistently implement --version. --help is the portable,
  // side-effect-free existence probe and does not require a live graph.
  //
  // Only the spawn is checked, not the exit status: this gate decides whether per-application
  // capture is offered at all, so a version whose --help returns non-zero would silently empty
  // the entire source list. A binary that runs exists; whether the graph can be read is a
  // separate question, answered by the enumeration itself and reported as an error there.
  const dump = spawnSync(config.paths.pwDump, ['--help'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const value = !record.error && record.status === 0 && !dump.error;
  availability = { value, expires: Date.now() + 5_000 };
  return value;
}

/**
 * PipeWire 1.2+ accepts `-a`/`--raw` for raw PCM on stdout. Ubuntu 24.04 / Mint ship 1.0.x,
 * where that flag does not exist and writing to `-` is already raw PCM when `--format` is set.
 * Probe --help once so both generations keep working.
 */
export function pwRecordSupportsRawFlag(
  helpText?: string,
): boolean {
  if (helpText !== undefined) {
    return /(?:^|\s)(?:-a|--raw)\b/.test(helpText);
  }
  if (rawFlagSupport && rawFlagSupport.expires > Date.now()) return rawFlagSupport.value;
  const help = spawnSync(config.paths.pwRecord, ['--help'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
  const value = !help.error && /(?:^|\s)(?:-a|--raw)\b/.test(text);
  rawFlagSupport = { value, expires: Date.now() + 60_000 };
  return value;
}

async function run(command: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const child = spawn(command, args, { windowsHide: true });
  let stdout = '';
  let stderr = '';
  let oversized = false;
  const maxOutput = 16 * 1024 * 1024;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (stdout.length + chunk.length > maxOutput) {
      oversized = true;
      child.kill();
      return;
    }
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk.slice(0, 64 * 1024 - stderr.length);
  });
  let code: number | null;
  try {
    [code] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(timer);
  }
  if (oversized) throw new Error(`${command} produced more than 16 MiB of output.`);
  if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 400)}`);
  return stdout;
}

async function dumpNodes(): Promise<PwNode[]> {
  if (nodeCache && nodeCache.expires > Date.now()) return nodeCache.value;
  if (nodeDump) return nodeDump;
  // pw-dump does not accept an object type as a positional argument. `pw-dump Node` asks for a
  // PipeWire remote literally named "Node", which normally fails and used to become an empty UI.
  // Dump the graph and filter Node objects from the returned JSON ourselves.
  nodeDump = run(config.paths.pwDump, []).then((raw) => {
    const value = parsePipewireDump(raw);
    nodeCache = { value, expires: Date.now() + 1_000 };
    return value;
  });
  try {
    return await nodeDump;
  } finally {
    nodeDump = undefined;
  }
}

export function parsePipewireDump(raw: string): PwNode[] {
  const merged = new Map<number, PwNode | null>();
  for (const document of splitJsonDocuments(raw)) {
    if (!Array.isArray(document)) throw new Error('pw-dump returned an invalid graph.');
    for (const entry of document) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Partial<PwNode>;
      if (typeof record.id !== 'number') continue;
      // A follow-up document mentioning an id with null info is pw-dump's "node removed".
      merged.set(record.id, record.info === null ? null : (record as PwNode));
    }
  }
  if (merged.size === 0 && raw.trim() !== '[]') {
    throw new Error('pw-dump returned no graph objects.');
  }
  return [...merged.values()]
    .filter((node): node is PwNode => node !== null)
    .filter((node) => String(node.type ?? '').endsWith(':Node'));
}

/**
 * pw-dump normally prints the graph as one JSON array. When the graph changes while the dump is
 * being taken, some PipeWire versions append further compact arrays (a disappearing node arrives
 * as [{"id":N,"info":null}]), leaving concatenated documents that JSON.parse rejects outright.
 * Split the stream on balanced top-level documents instead - strings respected - and let the
 * caller merge them in order.
 */
function splitJsonDocuments(raw: string): unknown[] {
  const documents: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[' || ch === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        documents.push(JSON.parse(raw.slice(start, index + 1)) as unknown);
        start = -1;
      }
    }
  }
  if (depth !== 0) throw new Error('pw-dump output ended inside a JSON document.');
  return documents;
}

/** The sink WirePlumber currently routes default playback to, by node name. */
async function defaultSinkName(): Promise<string | null> {
  try {
    // Metadata objects are not part of pw-dump; pw-metadata prints them, value JSON-encoded.
    // The tools ship together. Resolve the sibling directory without assuming the configured
    // pw-dump filename literally ends in "pw-dump" (it may be a versioned wrapper).
    const pwMetadata = join(dirname(config.paths.pwDump), 'pw-metadata');
    const raw = await run(pwMetadata, ['-n', 'default'], 5_000);
    const match = /default\.audio\.sink.*?"name"\s*:\s*"([^"]+)"/.exec(raw);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Applications currently holding a playback stream. PipeWire exposes each app's stream as its own
 * node, which is what makes per-app capture a first-class operation here — no loopback module,
 * no virtual sink. `running` state is the activity pulse: PipeWire suspends idle streams.
 */
export async function listPipewireApps(): Promise<ProcessInfo[]> {
  const nodes = await dumpNodes();
  return pipewireAppsFromNodes(nodes);
}

export function pipewireAppsFromNodes(nodes: readonly PwNode[]): ProcessInfo[] {
  return nodes
    .filter((node) => props(node)['media.class'] === 'Stream/Output/Audio')
    .filter((node) => !nodeName(node).startsWith('speech-dispatcher'))
    .map((node) => {
      const p = props(node);
      const name = String(
        p['application.name'] ??
          p['application.process.binary'] ??
          p['application.id'] ??
          nodeName(node),
      );
      return {
        pid: node.id,
        name,
        displayName: String(p['node.description'] ?? p['media.name'] ?? name),
        state: nodeState(node) === 'running' ? 'Active' : 'Inactive',
        peak: 0,
        deviceId: '',
      } satisfies ProcessInfo;
    });
}

/** User-facing failure text shared by both control surfaces without leaking command internals. */
export function pipewireDiscoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found|could not start/i.test(message)) {
    return 'PipeWire tools are missing. Install pipewire-bin, then restart Discord Audio Bridge.';
  }
  return (
    'Could not query the desktop PipeWire session. Run the bridge as the signed-in desktop user ' +
    'and run "discord-audio-bridge --doctor" for details.'
  );
}

/** Output devices (sinks). Capturing one records its monitor — everything playing through it. */
export async function listPipewireDevices(): Promise<DeviceInfo[]> {
  const [nodes, defaul] = await Promise.all([dumpNodes(), defaultSinkName()]);
  return nodes
    .filter((node) => props(node)['media.class'] === 'Audio/Sink')
    .map((node) => {
      const p = props(node);
      return {
        id: nodeName(node),
        name: String(p['node.description'] ?? nodeName(node)),
        isDefault: nodeName(node) === defaul,
        sampleRate: Number(p['audio.rate'] ?? DISCORD_AUDIO.sampleRate),
        channels: Number(p['audio.channels'] ?? DISCORD_AUDIO.channels),
        sampleFormat: 'f32',
      } satisfies DeviceInfo;
    });
}

async function monitorTargetFor(deviceId: string): Promise<string> {
  if (deviceId !== 'default') return resolveMonitor(deviceId);
  const defaul = await defaultSinkName();
  if (!defaul) {
    throw new Error(
      'Could not determine the default output device (is WirePlumber running?). Pick a device explicitly.',
    );
  }
  return resolveMonitor(defaul);
}

/**
 * A capture stream must link to a source, so device capture targets the sink's monitor node when
 * PipeWire exposes one, and the sink itself otherwise (pw-record then links via its monitor
 * ports). This must never fall back to "no target": a bare pw-record would capture the
 * microphone.
 */
async function resolveMonitor(sinkName: string): Promise<string> {
  const nodes = await dumpNodes();
  const byName = new Map(nodes.map((node) => [nodeName(node), node]));
  if (!byName.has(sinkName)) throw new Error(`No output device named "${sinkName}" is running.`);
  return byName.has(`${sinkName}.monitor`) ? `${sinkName}.monitor` : sinkName;
}

async function targetForApp(nodeId: number): Promise<string> {
  const node = (await dumpNodes()).find((candidate) => candidate.id === nodeId);
  const name = node ? nodeName(node) : '';
  if (!name || props(node!)['media.class'] !== 'Stream/Output/Audio') {
    throw new Error(`That application's audio stream is gone (it stopped or restarted).`);
  }
  return name;
}

export interface PipedTapOptions {
  /** PipeWire node id of an application stream, from listPipewireApps(). */
  nodeId?: number;
  /** Sink node name, or "default" for the sink WirePlumber routes playback to. */
  deviceId?: string;
  bufferMs?: number;
  gainDb?: number;
}

/**
 * A running pw-record capture: the Linux counterpart of AudioTap. pw-record pulls float samples
 * from the target node; the Pacer turns them into a real-time stream with silence fill, drift
 * trim, and metering, which is everything AudioTap's PacedWriter provides on Windows.
 */
export class PipedTap implements CaptureTap {
  readonly stream: Readable;
  readonly format: RawFormat;

  #child: ChildProcessWithoutNullStreams;
  #pacer: Pacer;
  #errors: Interface;
  #closed = false;
  #exited: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, pacer: Pacer, format: RawFormat, errors: Interface) {
    this.#child = child;
    this.#pacer = pacer;
    this.#errors = errors;
    this.format = format;
    this.stream = pacer.stream;
    this.#exited = once(child, 'close')
      .then(([code, signal]) => {
        log.info('pw-record exited', { pid: child.pid, code, signal });
      })
      .finally(() => this.#errors.close());
  }

  static async start(options: PipedTapOptions): Promise<PipedTap> {
    const target = options.deviceId
      ? await monitorTargetFor(options.deviceId)
      : await targetForApp(options.nodeId!);

    const bufferMs = options.bufferMs ?? config.capture.bufferMs;
    // Prefer --raw on PipeWire 1.2+; omit it on 1.0.x (Ubuntu 24.04/Mint) where the flag is
    // unrecognized and stdout "-" is already raw PCM once --format/--rate/--channels are set.
    const args = [
      ...(pwRecordSupportsRawFlag() ? ['--raw'] : []),
      '--format', 'f32',
      '--rate', String(DISCORD_AUDIO.sampleRate),
      '--channels', String(DISCORD_AUDIO.channels),
      '--target', target,
      '-', // raw PCM on stdout; diagnostics stay on stderr
    ];
    log.debug('spawning pw-record', { args });
    const child = spawn(config.paths.pwRecord, args, { windowsHide: true });
    await new Promise<void>((resolve, reject) => {
      const spawned = () => {
        child.off('error', failed);
        resolve();
      };
      const failed = (error: Error) => {
        child.off('spawn', spawned);
        reject(new Error(`Could not start pw-record: ${error.message}`, { cause: error }));
      };
      child.once('spawn', spawned);
      child.once('error', failed);
    });

    const errors = createInterface({ input: child.stderr });
    errors.on('line', (line) => (/\berror\b|failed/i.test(line) ? log.error(line) : log.debug(line)));

    const format: RawFormat = {
      sampleRate: DISCORD_AUDIO.sampleRate,
      channels: DISCORD_AUDIO.channels,
      sampleFormat: 'f32le',
      bitsPerSample: 32,
      encoding: 'IeeeFloat',
      latencyMs: bufferMs,
      source: 'pipewire',
      gainAppliedInTap: true, // applied in the Pacer, which is this tap's pacing half
    };

    const pacer = new Pacer(child.stdout, {
      sampleRate: format.sampleRate,
      channels: format.channels,
      targetMs: bufferMs,
    });
    if (options.gainDb) pacer.setGain(options.gainDb);

    const tap = new PipedTap(child, pacer, format, errors);
    pipewireChildren.add(child);
    child.once('close', () => pipewireChildren.delete(child));
    log.info('capture started', { pid: child.pid, target, ...format });
    return tap;
  }

  get stats(): TapStats {
    return this.#pacer.stats;
  }

  setGain(db: number): void {
    if (this.#closed) return;
    log.debug('updating pw-record gain via pacer', { pid: this.#child.pid, db });
    this.#pacer.setGain(db);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pacer.close();
    if (this.#child.exitCode === null) this.#child.kill('SIGTERM');
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 2_000);
    try {
      await this.#exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

const pipewireChildren = new Set<ChildProcessWithoutNullStreams>();

/** Shutdown backstop mirroring the AudioTap one, for sessions that lost their references. */
export async function closeAllPipedTaps(): Promise<void> {
  for (const child of pipewireChildren) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.allSettled(
    [...pipewireChildren].map(async (child) => {
      if (child.exitCode !== null) return;
      await Promise.race([once(child, 'close'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  );
}

/** Convenience re-export so session code can stay backend-agnostic. */
export type { TapOptions };
