// In-memory ring buffer of recent runs. Gone on restart, which is fine for a POC.
const MAX_RUNS = 20;
const MAX_SAMPLES_PER_RUN = 5000;

const runs = new Map(); // insertion order = age

export function createRun(runId, info) {
  runs.delete(runId);
  const run = { runId, ...info, startedAt: new Date().toISOString(), phase: 'start', status: null, summary: null, samples: [] };
  runs.set(runId, run);
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
  return run;
}

export function addSample(run, sample) {
  run.phase = sample.phase;
  if (sample.summary) run.summary = sample.summary;
  if (run.samples.length < MAX_SAMPLES_PER_RUN || sample.summary) run.samples.push(sample);
}

export const getRun = (runId) => runs.get(runId);

export function listRuns() {
  return [...runs.values()].reverse().map(({ samples, ...rest }) => ({ ...rest, sampleCount: samples.length }));
}
