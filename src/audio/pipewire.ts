import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { config, DISCORD_AUDIO } from '../config.ts';
import { logger } from '../logger.ts';
import { Pacer } from './pacer.ts';
import type { CaptureTap, DeviceInfo, ProcessInfo, RawFormat, TapOptions, TapStats } from './tap.ts';

const log = logger('pipewire');
let availability: boolean | undefined;

interface PwNode {
  id: number;
  type: string;
  state?: string;
  info?: { props?: Record<string, unknown>; state?: string };
}

const props = (node: PwNode): Record<string, unknown> => node.info?.props ?? {};
const nodeName = (node: PwNode): string => String(props(node)['node.name'] ?? '');
const nodeState = (node: PwNode): string => node.state ?? node.info?.state ?? '';

export function pipewireAvailable(): boolean {
  if (availability !== undefined) return availability;
  const record = spawnSync(config.paths.pwRecord, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const dump = spawnSync(config.paths.pwDump, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  availability = !record.error && record.status === 0 && !dump.error && dump.status === 0;
  return availability;
}

async function run(command: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const child = spawn(command, args, { windowsHide: true });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 400)}`);
  return stdout;
}

async function dumpNodes(): Promise<PwNode[]> {
  const raw = await run(config.paths.pwDump, ['Node']);
  const parsed = JSON.parse(raw) as PwNode[];
  return Array.isArray(parsed) ? parsed : [];
}

/** The sink WirePlumber currently routes default playback to, by node name. */
async function defaultSinkName(): Promise<string | null> {
  try {
    // Metadata objects are not part of pw-dump; pw-metadata prints them, value JSON-encoded.
    // Derived from the pw-dump path because the two ship in the same PipeWire tools package.
    const pwMetadata = config.paths.pwDump.replace(/pw-dump$/, 'pw-metadata');
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
  return nodes
    .filter((node) => props(node)['media.class'] === 'Stream/Output/Audio')
    .filter((node) => !nodeName(node).startsWith('speech-dispatcher'))
    .map((node) => {
      const p = props(node);
      const name = String(p['application.name'] ?? nodeName(node));
      return {
        pid: node.id,
        name,
        displayName: String(p['node.description'] ?? name),
        state: nodeState(node) === 'running' ? 'Active' : 'Inactive',
        peak: 0,
        deviceId: '',
      } satisfies ProcessInfo;
    });
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
  if (!name) throw new Error(`That application's audio stream is gone (it stopped or restarted).`);
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
  #closed = false;
  #exited: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, pacer: Pacer, format: RawFormat) {
    this.#child = child;
    this.#pacer = pacer;
    this.format = format;
    this.stream = pacer.stream;
    this.#exited = once(child, 'close').then(([code, signal]) => {
      log.info('pw-record exited', { pid: child.pid, code, signal });
    });
  }

  static async start(options: PipedTapOptions): Promise<PipedTap> {
    const target = options.deviceId
      ? await monitorTargetFor(options.deviceId)
      : await targetForApp(options.nodeId!);

    const bufferMs = options.bufferMs ?? config.capture.bufferMs;
    const args = [
      '--raw',
      '--format', 'f32',
      '--rate', String(DISCORD_AUDIO.sampleRate),
      '--channels', String(DISCORD_AUDIO.channels),
      '--target', target,
      '-', // raw PCM on stdout; diagnostics stay on stderr
    ];
    log.debug('spawning pw-record', { args });
    const child = spawn(config.paths.pwRecord, args, { windowsHide: true });

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

    const tap = new PipedTap(child, pacer, format);
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
