import { writeFileSync } from 'node:fs';
import type { TransportKind } from '@bb/protocol';
import { runBenchmark, type BenchmarkReport } from './runner.js';

/**
 * Benchmark CLI — DEVELOPMENT ONLY.
 *
 *   pnpm benchmark --transport socketio
 *   pnpm benchmark --transport websocket
 *   pnpm benchmark --transport both --clients 3 --pings 50 --buzz-trials 6
 *
 * Requires the benchmark server to be running (`pnpm benchmark:server`).
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function num(name: string, fallback: number): number {
  const parsed = Number(arg(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const requested = arg('transport', 'both');
const transports: TransportKind[] =
  requested === 'both' ? ['socketio', 'websocket'] : [requested as TransportKind];

const options = {
  host: arg('host', '127.0.0.1'),
  port: num('port', 4500),
  clients: num('clients', 3),
  pings: num('pings', 30),
  buzzTrials: num('buzz-trials', 6),
};

function printReport(report: BenchmarkReport): void {
  const line = (label: string, value: unknown): void => {
    console.log(`  ${label.padEnd(34)} ${String(value)}`);
  };

  console.log('');
  console.log(`=== ${report.transport.toUpperCase()} ===`);
  console.log('');
  console.log('  RTT (client clock, one clock only)');
  line('samples', report.rtt.count);
  line('median', `${report.rtt.medianMs} ms`);
  line('p95', `${report.rtt.p95Ms} ms`);
  line('p99', `${report.rtt.p99Ms} ms`);
  line('min / max', `${report.rtt.minMs} / ${report.rtt.maxMs} ms`);
  line('jitter (mean |Δrtt|)', `${report.rtt.jitterMs} ms`);

  console.log('');
  console.log('  Ordering');
  line('events observed', report.ordering.eventsObserved);
  line('out of order', report.ordering.outOfOrder);
  line('duplicated', report.ordering.duplicated);

  console.log('');
  console.log('  Duplicate intent');
  line('first accepted', report.duplicateIntent.firstAccepted);
  line('duplicate rejected', report.duplicateIntent.duplicateRejected);
  line('rejection code', report.duplicateIntent.rejectionCode ?? '-');
  line('client can identify original', report.duplicateIntent.identifiedOriginalSeq);

  console.log('');
  console.log('  Benchmark buzzer (server receive order only)');
  line('accepted', report.buzz.totalAccepted);
  line('rejected', report.buzz.totalRejected);
  for (const trial of report.buzz.trials) {
    line(
      `  trial ${trial.trial} ${trial.scheduleLabel}`,
      `winner=${trial.winner ?? 'none'} +${trial.elapsedSinceOpenMs ?? '-'}ms`,
    );
  }

  console.log('');
  console.log('  Timer / pause');
  line('remaining before pause', `${report.timer.remainingBeforePauseMs} ms`);
  line('pause held', `${report.timer.pauseHeldMs} ms`);
  line('remaining after pause', `${report.timer.remainingAfterPauseMs} ms`);
  line('consumed while paused', `${report.timer.consumedWhilePausedMs} ms (expect ~0)`);

  console.log('');
  console.log('  Pause authority');
  line('player resume rejected', report.pause.playerResumeRejected);
  line('player rejection code', report.pause.playerRejectionCode ?? '-');
  line('host resume accepted', report.pause.hostResumeAccepted);
  line('double pause rejected', report.pause.doublePauseRejected);
  line('resume while running rejected', report.pause.resumeWhileRunningRejected);

  console.log('');
  console.log('  Reconnect');
  line('reconnect time', `${report.reconnect.reconnectMs} ms`);
  line('identity restored', report.reconnect.identityRestored);
  line('duplicate client created', `${report.reconnect.duplicateClientCreated} (expect false)`);
  line('auto-resumed', `${report.reconnect.resumedAutomatically} (MUST be false)`);

  if (report.errors.length > 0) {
    console.log('');
    console.log('  Errors');
    for (const error of report.errors) console.log(`    ${error}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const reports: BenchmarkReport[] = [];

  for (const transport of transports) {
    console.log(`\nRunning ${transport} against ${options.host}:${options.port} ...`);
    const report = await runBenchmark({ ...options, transport });
    reports.push(report);
    printReport(report);
  }

  const out = arg('out', '');
  if (out !== '') {
    writeFileSync(out, JSON.stringify(reports, null, 2), 'utf8');
    console.log(`Wrote ${out}`);
  }
}

main().catch((err: unknown) => {
  console.error('benchmark failed:', err);
  process.exit(1);
});
