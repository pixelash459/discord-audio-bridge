import { collectDiagnostics } from './commands.ts';
import { listDshowDevices } from './audio/encoder.ts';
import { isAudioTapBuilt, listDevices, listProcesses } from './audio/tap.ts';

process.stdout.write(`${await collectDiagnostics()}\n\n`);

if (isAudioTapBuilt()) {
  const [processes, devices] = await Promise.all([
    listProcesses().catch((error: Error) => error),
    listDevices().catch((error: Error) => error),
  ]);

  process.stdout.write('--- applications holding an audio session ---\n');
  if (processes instanceof Error) {
    process.stdout.write(`  failed: ${processes.message}\n`);
  } else {
    for (const p of processes) {
      process.stdout.write(
        `  ${p.state === 'Active' ? '>' : ' '} ${String(p.pid).padStart(6)}  ${p.name}  (peak ${p.peak.toFixed(3)})\n`,
      );
    }
    if (processes.length === 0) process.stdout.write('  (none — start playing something)\n');
  }

  process.stdout.write('\n--- render endpoints ---\n');
  if (devices instanceof Error) {
    process.stdout.write(`  failed: ${devices.message}\n`);
  } else {
    for (const d of devices) {
      process.stdout.write(
        `  ${d.isDefault ? '*' : ' '} ${d.name}  ${d.sampleRate} Hz ${d.channels}ch ${d.sampleFormat}\n`,
      );
    }
  }
} else {
  process.stdout.write('--- AudioTap not built; skipping process/device enumeration ---\n');
}

const dshow = await listDshowDevices().catch((error: Error) => error);
process.stdout.write('\n--- DirectShow audio inputs ---\n');
if (dshow instanceof Error) {
  process.stdout.write(`  failed: ${dshow.message}\n`);
} else if (dshow.length === 0) {
  process.stdout.write('  (none)\n');
} else {
  for (const d of dshow) process.stdout.write(`  ${d.name}\n`);
}
