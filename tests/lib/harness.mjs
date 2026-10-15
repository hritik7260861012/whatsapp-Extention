/**
 * Minimal zero-dependency test harness (no external packages).
 *
 * Supports both synchronous and asynchronous checks. Asynchronous checks
 * are awaited by report(), so a rejected assertion is recorded as a real
 * failure instead of an unhandled rejection.
 */
export const results = { sections: [] };

let currentSection = null;
const pending = [];

export function section(name) {
  currentSection = { name, checks: [] };
  results.sections.push(currentSection);
}

function record(entry, value) {
  if (value === false) {
    entry.status = 'fail';
    entry.message = 'returned false';
  } else if (value && typeof value === 'object' && typeof value.ok === 'boolean') {
    entry.status = value.ok ? 'pass' : 'fail';
    entry.message = value.message || '';
  } else {
    entry.status = 'pass';
  }
}

function printEntry(entry) {
  const mark = entry.status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${entry.name}${entry.status === 'fail' ? ' -> ' + entry.message : ''}`);
}

export function check(name, fn) {
  const entry = { name, status: 'pass', message: '', settled: false };
  currentSection.checks.push(entry);

  let value;
  try {
    value = fn();
  } catch (err) {
    entry.status = 'fail';
    entry.message = (err && err.message) || String(err);
    entry.settled = true;
    printEntry(entry);
    return true;
  }

  if (value && typeof value.then === 'function') {
    const settled = value.then(
      v => {
        entry.settled = true;
        record(entry, v);
        printEntry(entry);
      },
      err => {
        entry.settled = true;
        entry.status = 'fail';
        entry.message = (err && err.message) || String(err);
        printEntry(entry);
      }
    );
    pending.push(settled);
    // Await the returned promise to run asynchronous checks sequentially;
    // without `await` they would all race and corrupt each other's state.
    return settled;
  }

  entry.settled = true;
  record(entry, value);
  printEntry(entry);
  return entry.status === 'pass';
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
  return true;
}

export function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return true;
}

export function deepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'not deep equal'}: expected ${b}, got ${a}`);
  return true;
}

export function includes(haystack, needle, message) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error(`${message || 'missing substring'}: ${JSON.stringify(needle)} not found in ${JSON.stringify(String(haystack).slice(0, 200))}`);
  }
  return true;
}

export function notIncludes(haystack, needle, message) {
  if (String(haystack).indexOf(needle) !== -1) {
    throw new Error(`${message || 'unexpected substring'}: ${JSON.stringify(needle)} was found`);
  }
  return true;
}

export async function report() {
  if (pending.length) await Promise.allSettled(pending);

  let passed = 0;
  let failed = 0;
  console.log('');
  console.log('='.repeat(72));
  for (const s of results.sections) {
    const bad = s.checks.filter(c => c.status === 'fail');
    passed += s.checks.length - bad.length;
    failed += bad.length;
    console.log(`  ${bad.length === 0 ? 'OK  ' : 'FAIL'} ${s.name}  (${s.checks.length - bad.length}/${s.checks.length})`);
    for (const c of bad) console.log(`        - ${c.name}: ${c.message}`);
  }
  console.log('='.repeat(72));
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(72));
  results.passed = passed;
  results.failed = failed;
  return failed === 0;
}