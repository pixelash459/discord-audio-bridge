import { spawnSync } from 'node:child_process';
import { generateDependencyReport } from '@discordjs/voice';

import { captureBackend } from './audio/tap.ts';
import { config } from './config.ts';
import { IS_WINDOWS } from './platform.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  /** One line naming what was found. Shown next to the label. */
  detail: string;
  /** What to do about it, when there is something to do. */
  remedy?: string;
  /**
   * A control-panel action that fixes this directly, so a failed check is a button rather than an
   * instruction: an API route path, or an `open:<url>` for something only a browser can do.
   */
  action?: string;
}

export interface DiagnosticsReport {
  checks: Check[];
  summary: { ok: number; warn: number; fail: number };
  /** @discordjs/voice's own dependency dump, which is only ever read verbatim. */
  voiceReport: string;
  generatedAt: number;
}

function probe(command: string, args: string[]): { ok: boolean; firstLine: string; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) return { ok: false, firstLine: '', output: '' };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    ok: result.status === 0,
    firstLine: output.split(/\r?\n/)[0]?.trim() ?? '',
    output,
  };
}

/**
 * The dependency report as data rather than prose.
 *
 * The text version could only ever be read and re-typed into a search engine. Structured checks let
 * the panel show a row per dependency with its own fix button, and let a failure point at the exact
 * thing that will resolve it - which is the difference between a diagnostic and a diagnosis.
 */
export function collectChecks(): Check[] {
  const checks: Check[] = [];

  checks.push({
    id: 'node',
    label: 'Node.js',
    status: 'ok',
    detail: `${process.version} on ${process.platform}/${process.arch}`,
  });

  const ffmpeg = probe(config.paths.ffmpeg, ['-version']);
  checks.push(
    ffmpeg.ok
      ? { id: 'ffmpeg', label: 'ffmpeg', status: 'ok', detail: ffmpeg.firstLine }
      : {
          id: 'ffmpeg',
          label: 'ffmpeg',
          status: 'fail',
          detail: `not found at "${config.paths.ffmpeg}"`,
          remedy: IS_WINDOWS
            ? 'Install it with: winget install Gyan.FFmpeg, then restart the bridge.'
            : 'Install the ffmpeg package for your distribution, then restart the bridge.',
          action: 'open:https://ffmpeg.org/download.html',
        },
  );

  if (ffmpeg.ok) {
    const opus = probe(config.paths.ffmpeg, ['-hide_banner', '-h', 'encoder=libopus']);
    checks.push(
      opus.output.includes('libopus')
        ? { id: 'libopus', label: 'libopus encoder', status: 'ok', detail: 'available' }
        : {
            id: 'libopus',
            label: 'libopus encoder',
            status: 'fail',
            detail: 'this ffmpeg build has no libopus encoder',
            remedy: 'Install a full ffmpeg build. Discord voice is Opus-only, so nothing can stream without it.',
            action: 'open:https://ffmpeg.org/download.html',
          },
    );

    const filters = probe(config.paths.ffmpeg, ['-hide_banner', '-filters']);
    const hasLoudnorm = filters.output.includes('loudnorm');
    const hasLimiter = filters.output.includes('alimiter');
    if (!hasLoudnorm || !hasLimiter) {
      checks.push({
        id: 'loudness-filters',
        label: 'Loudness filters',
        status: 'warn',
        detail: `missing ${[!hasLimiter && 'alimiter', !hasLoudnorm && 'loudnorm'].filter(Boolean).join(' and ')}`,
        remedy: 'Set the loudness mode to "off" in Setup, or install a full ffmpeg build.',
      });
    }
  }

  const backend = captureBackend();
  if (IS_WINDOWS) {
    checks.push(
      backend === 'wasapi'
        ? { id: 'audiotap', label: 'AudioTap', status: 'ok', detail: config.paths.audioTap }
        : {
            id: 'audiotap',
            label: 'AudioTap',
            status: 'warn',
            detail: `not built (expected ${config.paths.audioTap})`,
            remedy: 'Per-app capture needs it. Cable sources still work without it.',
            action: '/api/setup/build-native',
          },
    );

    const dotnet = probe('dotnet', ['--version']);
    const major = Number.parseInt(dotnet.firstLine.split('.')[0] ?? '', 10);
    const bundled = backend === 'wasapi';
    checks.push(
      dotnet.ok && major >= 10
        ? { id: 'dotnet', label: '.NET SDK', status: 'ok', detail: dotnet.firstLine }
        : {
            id: 'dotnet',
            label: '.NET SDK',
            status: bundled ? 'ok' : 'warn',
            detail: bundled
              ? `${dotnet.ok ? dotnet.firstLine : 'not installed'} (optional; AudioTap is already built)`
              : dotnet.ok
                ? `${dotnet.firstLine} - too old to build AudioTap`
                : 'not installed',
            ...(bundled
              ? {}
              : {
                  remedy: 'Needed only to build AudioTap: winget install Microsoft.DotNet.SDK.10',
                  action: 'open:https://dotnet.microsoft.com/download',
                }),
          },
    );
  } else {
    const pw = probe(config.paths.pwRecord, ['--version']);
    checks.push(
      pw.ok
        ? { id: 'pipewire', label: 'pw-record', status: 'ok', detail: pw.firstLine || 'available' }
        : {
            id: 'pipewire',
            label: 'pw-record',
            status: 'warn',
            detail: `not found at "${config.paths.pwRecord}"`,
            remedy: 'apt install pipewire-bin (Debian/Ubuntu) or dnf install pipewire-utils (Fedora).',
          },
    );
  }

  const ffplay = probe(config.paths.ffplay, ['-version']);
  checks.push(
    ffplay.ok
      ? { id: 'ffplay', label: 'Local preview', status: 'ok', detail: ffplay.firstLine }
      : {
          id: 'ffplay',
          label: 'Local preview',
          status: 'warn',
          detail: `ffplay not found at "${config.paths.ffplay}"`,
          remedy: 'Optional. It ships with a full ffmpeg build and is only used to monitor a stream locally.',
        },
  );

  checks.push({
    id: 'log-file',
    label: 'Log file',
    status: config.paths.logFile ? 'ok' : 'warn',
    detail: config.paths.logFile ?? 'disabled (in-memory only)',
    ...(config.paths.logFile ? {} : { remedy: 'Set LOG_FILE in Setup to keep a record across restarts.' }),
  });

  checks.push(
    config.remote.port > 0
      ? {
          id: 'remote',
          label: 'Remote dashboard',
          // Listening on every interface is a deliberate default, but it is worth naming out loud
          // rather than leaving someone to discover it from a port scan.
          status: config.remote.host === '0.0.0.0' || config.remote.host === '::' ? 'warn' : 'ok',
          detail: `${config.remote.host}:${config.remote.port}`,
          ...(config.remote.host === '0.0.0.0' || config.remote.host === '::'
            ? { remedy: 'Reachable from the whole network. Bind one interface, or set REMOTE_PORT=0 to disable.' }
            : {}),
        }
      : { id: 'remote', label: 'Remote dashboard', status: 'ok', detail: 'disabled' },
  );

  return checks;
}

export function collectReport(): DiagnosticsReport {
  const checks = collectChecks();
  return {
    checks,
    summary: {
      ok: checks.filter((check) => check.status === 'ok').length,
      warn: checks.filter((check) => check.status === 'warn').length,
      fail: checks.filter((check) => check.status === 'fail').length,
    },
    voiceReport: generateDependencyReport(),
    generatedAt: Date.now(),
  };
}

/** The same information as plain text, for the slash command and `--doctor`. */
export function renderReport(report: DiagnosticsReport = collectReport()): string {
  const width = Math.max(...report.checks.map((check) => check.label.length));
  const mark: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

  const lines = report.checks.flatMap((check) => {
    const row = `[${mark[check.status]}] ${check.label.padEnd(width)}  ${check.detail}`;
    return check.remedy ? [row, `${' '.repeat(width + 9)}${check.remedy}`] : [row];
  });

  return [
    '--- host ---',
    ...lines,
    '',
    '--- @discordjs/voice ---',
    report.voiceReport,
  ].join('\n');
}
