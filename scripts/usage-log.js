#!/usr/bin/env node
'use strict';

// `npm run log` — read back the usage history the widget records.
//
// Answers three questions, in order:
//   1. How much of each quota did I burn over this range?
//   2. Which hours did it go in?
//   3. Did any of it burn while no local agent was running? (leak / stuck job)
//
// Usage:
//   npm run log                 today
//   npm run log -- --days 7     last 7 calendar days
//   npm run log -- --alerts     only the warnings
//   npm run log -- --json       raw summary as JSON
//   npm run log -- --dir <path> read a log folder somewhere else

const path = require('path');
const {
  defaultLogDir, readRecords, summarize, hourlyBuckets, LOG_DEFAULTS,
} = require('../src/usage-log');

function parseArgs(argv) {
  const args = { days: 1, dir: defaultLogDir(), json: false, alertsOnly: false, metric: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days' || a === '-d') args.days = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--dir') args.dir = path.resolve(argv[++i] || '.');
    else if (a === '--metric' || a === '-m') args.metric = (argv[++i] || '').toLowerCase();
    else if (a === '--json') args.json = true;
    else if (a === '--alerts') args.alertsOnly = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `Usage: npm run log -- [options]

  -d, --days <n>     how many calendar days back to read (default 1 = today)
  -m, --metric <s>   only metrics whose name contains <s> (e.g. claude, session)
      --alerts       print only the alerts
      --json         print the summary as JSON
      --dir <path>   read a different log folder
  -h, --help         this text
`;

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function localTime(iso) {
  return new Date(iso).toLocaleString([], {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }

  const records = readRecords(args.dir, { days: args.days });
  const summary = summarize(records);

  if (args.metric) {
    for (const key of Object.keys(summary.metrics)) {
      if (!key.toLowerCase().includes(args.metric)) delete summary.metrics[key];
    }
    summary.alerts = summary.alerts.filter((a) => !a.metric || a.metric.toLowerCase().includes(args.metric));
  }

  if (args.json) {
    console.log(JSON.stringify({ ...summary, hourly: hourlyBuckets(records) }, null, 2));
    return;
  }

  console.log(`Usage log  ${args.dir}`);
  if (!records.length) {
    console.log(`\nNo records in the last ${args.days} day(s). Is "Record usage history" on in the tray menu?`);
    return;
  }
  console.log(`Range      ${localTime(summary.from)} -> ${localTime(summary.to)}  (${summary.samples} samples)\n`);

  if (!args.alertsOnly) {
    const names = Object.keys(summary.metrics).sort();
    const w = Math.max(6, ...names.map((n) => n.length));
    console.log(`${pad('metric', w)}  ${padLeft('start', 6)}${padLeft('now', 6)}${padLeft('peak', 6)}${padLeft('used', 7)}${padLeft('idle', 7)}  resets`);
    console.log('-'.repeat(w + 40));
    for (const name of names) {
      const m = summary.metrics[name];
      const idle = m.idleGained > 0 ? `+${m.idleGained}` : '-';
      console.log(
        `${pad(name, w)}  ${padLeft(m.first + '%', 6)}${padLeft(m.last + '%', 6)}${padLeft(m.peak + '%', 6)}` +
        `${padLeft('+' + m.gained, 7)}${padLeft(idle, 7)}  ${m.resets}`
      );
    }
    console.log('\n  used = points gained over the range (survives window resets)');
    console.log(`  idle = of those, points gained with no local agent for ${LOG_DEFAULTS.idleMinutes}+ min`);

    const buckets = hourlyBuckets(records).filter((b) => Object.keys(b.gains).length);
    if (buckets.length) {
      console.log('\nBy hour');
      for (const b of buckets) {
        const parts = Object.entries(b.gains)
          .filter(([metric]) => !args.metric || metric.toLowerCase().includes(args.metric))
          .sort((a, c) => c[1] - a[1])
          .map(([metric, pts]) => `${metric} +${pts}${b.idleGains[metric] ? ` (${b.idleGains[metric]} idle)` : ''}`);
        if (parts.length) console.log(`  ${b.hour.replace('T', ' ')}:00Z  ${parts.join('   ')}`);
      }
    }
  }

  if (summary.alerts.length) {
    console.log(`\n⚠ Alerts (${summary.alerts.length})`);
    for (const a of summary.alerts) console.log(`  ${localTime(a.t)}  ${pad(a.type, 16)} ${a.message}`);
    const drains = summary.alerts.filter((a) => a.type === 'idle-drain').length;
    if (drains) {
      console.log(`\n  ${drains} idle-drain alert(s): quota moved while no local agent was running.`);
      console.log('  Check for another machine or service using the same key, a background');
      console.log('  job left running, or a leaked key — then rotate it if nothing explains it.');
    }
  } else if (!args.alertsOnly) {
    console.log('\nNo alerts in this range.');
  }
}

main();
