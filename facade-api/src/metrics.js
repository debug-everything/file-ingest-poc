import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Decimal units throughout: MB = 1e6 bytes, GB = 1e9 bytes.
const MB = 1e6;
const GB = 1e9;
const BYTES_PER_SAMPLE = 64 * 1024 * 1024;

const CGROUP_V2 = {
  memCurrent: '/sys/fs/cgroup/memory.current',
  memMax: '/sys/fs/cgroup/memory.max',
  cpuStat: ['/sys/fs/cgroup/cpu.stat'],
  throttledKey: 'throttled_usec',
  throttledDivisor: 1,
};
const CGROUP_V1 = {
  memCurrent: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
  memMax: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  cpuStat: ['/sys/fs/cgroup/cpu/cpu.stat', '/sys/fs/cgroup/cpu,cpuacct/cpu.stat'],
  throttledKey: 'throttled_time', // nanoseconds in v1
  throttledDivisor: 1000,
};
const cgroupPaths = [CGROUP_V2, CGROUP_V1].find((c) => fs.existsSync(c.memCurrent)) ?? null;

const round1 = (n) => Math.round(n * 10) / 10;

function readNumber(file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(n) ? n : null; // "max" means no limit
  } catch {
    return null;
  }
}

function readCpuStat(files) {
  for (const file of files) {
    try {
      return Object.fromEntries(
        fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => {
          const [key, value] = line.split(' ');
          return [key, Number(value)];
        }),
      );
    } catch {
      // try the next path
    }
  }
  return {};
}

export function readCgroup() {
  if (!cgroupPaths) return null;
  const stat = readCpuStat(cgroupPaths.cpuStat);
  const throttled = stat[cgroupPaths.throttledKey];
  return {
    memCurrent: readNumber(cgroupPaths.memCurrent),
    memMax: readNumber(cgroupPaths.memMax),
    cpuNrThrottled: stat.nr_throttled ?? null,
    cpuThrottledUsec: throttled === undefined ? null : Math.round(throttled / cgroupPaths.throttledDivisor),
  };
}

/**
 * One sampler per run. `emit(sample)` gets every sample (stdout + ring buffer).
 * Note: process.cpuUsage() and memoryUsage() are process-wide, so concurrent runs share those numbers.
 */
export function createSampler({ runId, intervalMs, emit }) {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  let timer = null;
  let startNs = 0n;
  let lastNs = 0n;
  let cpuStart = null;
  let cpuLast = null;
  let bytes = 0;
  let bytesLast = 0;
  let nextByteMark = BYTES_PER_SAMPLE;
  let backpressureEvents = 0;
  let drainWaitMs = 0;
  let startRss = 0;
  let peakRss = 0;
  let peakHeapUsed = 0;
  let throttledStart = null;
  let done = false;

  function sample(phase, extra) {
    const nowNs = process.hrtime.bigint();
    const elapsedMs = Number(nowNs - startNs) / 1e6;
    const sinceLastMs = Number(nowNs - lastNs) / 1e6;
    const cpuTotal = process.cpuUsage(cpuStart);
    const cpuDelta = process.cpuUsage(cpuLast);
    cpuLast = process.cpuUsage();
    const mem = process.memoryUsage();
    peakRss = Math.max(peakRss, mem.rss);
    peakHeapUsed = Math.max(peakHeapUsed, mem.heapUsed);

    const s = {
      ts: new Date().toISOString(),
      runId,
      phase,
      elapsedMs: Math.round(elapsedMs),
      bytes,
      throughputMBps: sinceLastMs > 0 ? round1((bytes - bytesLast) / MB / (sinceLastMs / 1000)) : 0,
      backpressureEvents,
      drainWaitMs: Math.round(drainWaitMs),
      cpu: {
        userMs: round1(cpuTotal.user / 1000),
        systemMs: round1(cpuTotal.system / 1000),
        pctOfOneCoreSinceLast: sinceLastMs > 0 ? round1(((cpuDelta.user + cpuDelta.system) / 1000 / sinceLastMs) * 100) : 0,
      },
      mem: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      cgroup: readCgroup(),
      eventLoop: loopDelay.count
        ? { p50Ms: round1(loopDelay.percentile(50) / 1e6), p99Ms: round1(loopDelay.percentile(99) / 1e6), maxMs: round1(loopDelay.max / 1e6) }
        : null,
      ...extra,
    };
    loopDelay.reset();
    lastNs = nowNs;
    bytesLast = bytes;
    emit(s);
    return s;
  }

  return {
    start(extra) {
      startNs = lastNs = process.hrtime.bigint();
      cpuStart = cpuLast = process.cpuUsage();
      loopDelay.enable();
      const s = sample('start', extra);
      startRss = s.mem.rss;
      throttledStart = s.cgroup?.cpuThrottledUsec ?? null;
      timer = setInterval(() => sample('sample'), intervalMs);
      timer.unref();
    },
    firstByte(extra) {
      sample('first_byte', extra);
    },
    addBytes(n) {
      bytes += n;
      if (bytes >= nextByteMark) {
        nextByteMark += BYTES_PER_SAMPLE;
        sample('sample');
      }
    },
    backpressure() {
      backpressureEvents += 1;
    },
    addDrainWait(ms) {
      drainWaitMs += ms;
    },
    get bytes() {
      return bytes;
    },
    /** phase: end | aborted | error */
    finish(phase, extra) {
      if (done) return null;
      done = true;
      clearInterval(timer);
      const nowNs = process.hrtime.bigint();
      const durationMs = Number(nowNs - startNs) / 1e6;
      const cpu = process.cpuUsage(cpuStart);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      const mem = process.memoryUsage();
      peakRss = Math.max(peakRss, mem.rss);
      peakHeapUsed = Math.max(peakHeapUsed, mem.heapUsed);
      const throttledNow = readCgroup()?.cpuThrottledUsec ?? null;
      const summary = {
        totalBytes: bytes,
        durationMs: Math.round(durationMs),
        avgMBps: durationMs > 0 ? round1(bytes / MB / (durationMs / 1000)) : 0,
        peakRss,
        peakHeapUsed,
        rssDeltaFromStart: peakRss - startRss,
        cpuMs: round1(cpuMs),
        cpuMsPerGB: bytes > 0 ? round1(cpuMs / (bytes / GB)) : null,
        cpuThrottledMs: throttledNow !== null && throttledStart !== null ? round1((throttledNow - throttledStart) / 1000) : null,
        backpressureEvents,
        // Share of the run spent waiting on the client socket. Read it next to cpuThrottledMs:
        // a wait that spans a CPU throttle pause is counted here too.
        drainWaitMs: Math.round(drainWaitMs),
        drainWaitPct: durationMs > 0 ? round1((drainWaitMs / durationMs) * 100) : 0,
      };
      const s = sample(phase, { ...extra, summary });
      loopDelay.disable();
      return s;
    },
  };
}
