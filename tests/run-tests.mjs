#!/usr/bin/env node
/**
 * WhatsApp Clean UI - full test suite.
 *
 *   node tests/run-tests.mjs            # everything (static + unit + browser)
 *   node tests/run-tests.mjs --no-browser   # skip the real-browser group
 *   node tests/run-tests.mjs --only=static  # one group: static | unit | browser
 *
 * No npm packages are required. The browser group drives a throwaway
 * Chromium/Edge profile over the DevTools Protocol and deletes it again;
 * your normal browser profile is never touched.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { report } from './lib/harness.mjs';
import { runStaticTests } from './static.test.mjs';
import { runUnitTests } from './unit.test.mjs';
import { runBrowserTests } from './browser.test.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, '..');

const args = process.argv.slice(2);
const skipBrowser = args.includes('--no-browser');
const only = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];

const t0 = Date.now();

console.log('');
console.log('WhatsApp Clean UI - test suite');
console.log('project: ' + projectDir);
console.log('');

if (!only || only === 'static') {
  console.log('--- Static checks (manifest, integrity, source review) ---');
  try {
    runStaticTests(projectDir);
  } catch (err) {
    console.log('  [FAIL] static group crashed: ' + (err && err.stack || err));
    process.exitCode = 1;
  }
  console.log('');
}

if (!only || only === 'unit') {
  console.log('--- Unit tests (real sources in a vm sandbox, stubbed chrome APIs) ---');
  try {
    runUnitTests(projectDir);
  } catch (err) {
    console.log('  [FAIL] unit group crashed: ' + (err && err.stack || err));
    process.exitCode = 1;
  }
  console.log('');
}

if (!only || only === 'browser') {
  if (skipBrowser) {
    console.log('--- Real browser tests SKIPPED (--no-browser) ---');
    console.log('');
  } else {
    console.log('--- Real browser tests (Chromium/Edge via DevTools Protocol) ---');
    try {
      const r = await runBrowserTests(projectDir);
      console.log('');
      console.log('  browser info: ' + JSON.stringify(r));
    } catch (err) {
      console.log('  [FAIL] browser group crashed: ' + (err && err.stack || err));
      process.exitCode = 1;
    }
    console.log('');
  }
}

const ok = await report();
console.log(`  duration: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(ok && !process.exitCode ? 0 : 1);