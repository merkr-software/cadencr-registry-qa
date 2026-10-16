import { spawn } from 'node:child_process';
import { access, open } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFaultProxy } from './fault-proxy.mjs';
import { assertX8664Elf } from './evidence.mjs';

const REPOSITORY = 'merkr-software/cadencr-registry-qa';
const OBSERVE_MS = 180_000;
const EXIT_MS = 90_000;

export function cleanProxyEnv(env, proxy, publicSmoke = false) {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)) delete result[key];
    if (publicSmoke && /token|credential|authorization|secret/i.test(key)) delete result[key];
  }
  if (proxy) result.HTTPS_PROXY = proxy;
  return result;
}

function run(binary, args, env) {
  const child = spawn(binary, args, { env, stdio: 'inherit' });
  const status = { exited: false };
  const completion = new Promise(resolve => {
    child.once('error', () => {
      Object.assign(status, { exited: true, spawnError: true, exitTime: Date.now() });
      resolve(status);
    });
    child.once('exit', (code, signal) => {
      Object.assign(status, { exited: true, code, signal, exitTime: Date.now() });
      resolve(status);
    });
  });
  return { child, status, completion };
}

export async function boundedExit(process, milliseconds, terminalTimeout = true) {
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), milliseconds); });
  const result = await Promise.race([process.completion, expired]);
  clearTimeout(timer);
  if (!result) {
    if (terminalTimeout) process.child.unref();
    throw new Error('CLI exit deadline exceeded; inconclusive, no process killed');
  }
  return result;
}

function exactRelease(tag, token) {
  const path = `/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`;
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: 'api.github.com', path, headers: {
      Accept: 'application/vnd.github+json', 'User-Agent': 'cadencr-isolated-qa',
      Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
    } }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) response.destroy(new Error('Observer response exceeded bound'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('Observer response failed')));
      response.on('end', () => {
        if (response.statusCode === 404) return resolve(null);
        if (response.statusCode !== 200) return reject(new Error(`Observer HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Observer invalid JSON')); }
      });
    });
    const deadline = setTimeout(() => request.destroy(), 10_000);
    request.once('close', () => clearTimeout(deadline));
    request.setTimeout(10_000, () => request.destroy());
    request.on('error', () => reject(new Error('Direct observer request failed')));
  });
}

export function matchesRelease(release, { expectedTag, expectedCommit, expectedSha256, expectedSize }) {
  if (!release || !Number.isSafeInteger(release.id) || release.id <= 0
    || release.tag_name !== expectedTag || release.draft !== false
    || release.target_commitish !== expectedCommit || !Array.isArray(release.assets)
    || release.assets.length !== 2) return false;
  if (!release.assets.every(asset => asset && Number.isSafeInteger(asset.id) && asset.id > 0)) return false;
  const archive = release.assets.find(asset => asset.name === 'theme.tar.gz');
  const plan = release.assets.find(asset => asset.name === 'publication-plan.json');
  return Boolean(archive && plan && archive.id !== plan.id && archive.size === expectedSize
    && archive.digest === `sha256:${expectedSha256}`
    && Number.isSafeInteger(plan.size) && plan.size > 0 && plan.size <= 4 * 1024 * 1024
    && typeof plan.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(plan.digest));
}

export function assertInterrupted({ code, signal, spawnError, exitTime, faultTime, firstFaultReason, observedTime, lockExists, discoveryExists }) {
  if (spawnError || signal || !Number.isInteger(code) || code === 0) throw new Error('CLI did not exit normally with nonzero status');
  if (firstFaultReason !== 'injected') throw new Error('First proxy fault was not deliberate injection');
  if (!observedTime || !faultTime || observedTime > faultTime || faultTime >= exitTime) throw new Error('No publication sentinel and fault before CLI exit');
  if (lockExists) throw new Error('Pipeline lock remains');
  if (discoveryExists) throw new Error('Discovery receipt indicates completed publication');
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function proveSmoke(binary, env, proxy, submission, smokeDirectory) {
  const process = run(binary, ['registry', 'stage-publication', '--submission', submission,
    '--repository', REPOSITORY, '--directory', smokeDirectory], cleanProxyEnv(env, proxy.url, true));
  let result;
  try { result = await boundedExit(process, OBSERVE_MS, false); }
  catch (error) { proxy.fault(); await boundedExit(process, EXIT_MS); throw error; }
  if (result.spawnError || result.signal || result.code !== 0 || proxy.stats().accepted === 0) {
    throw new Error('Read-only ELF proxy traversal smoke failed');
  }
}

async function observe(process, token, expected) {
  const deadline = Date.now() + OBSERVE_MS;
  while (Date.now() < deadline) {
    if (process.status.exited) throw new Error('CLI exited before publication sentinel');
    const release = await exactRelease(expected.expectedTag, token);
    if (matchesRelease(release, expected)) return release;
    await sleep(250);
  }
  throw new Error('Publication observation deadline exceeded');
}

export async function interruptPublication({ binary, args, env, state, smokeDirectory,
  submission = 'requests/submission.json', expectedTag, expectedCommit, expectedSha256, expectedSize = 1100 }) {
  const token = env.CADENCR_REGISTRY_GITHUB_TOKEN;
  if (!token) throw new Error('Ephemeral QA repository token required');
  const handle = await open(binary, 'r');
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, 64, 0);
    assertX8664Elf(header.subarray(0, bytesRead));
  } finally { await handle.close(); }
  const proxy = await startFaultProxy({ delayMs: 750 });
  let process;
  try {
    await proveSmoke(binary, env, proxy, submission, smokeDirectory);
    if (await exactRelease(expectedTag, token)) throw new Error('Expected new managed release tag already exists');
    const expected = { expectedTag, expectedCommit, expectedSha256, expectedSize };
    process = run(binary, args, cleanProxyEnv(env, proxy.url));
    const release = await observe(process, token, expected);
    const observedTime = Date.now();
    if (proxy.stats().faulted) throw new Error('Proxy fault preceded deliberate publication interruption');
    proxy.fault('injected');
    const { firstFaultTime: faultTime, firstFaultReason } = proxy.stats();
    const result = await boundedExit(process, EXIT_MS);
    assertInterrupted({ ...result, observedTime, faultTime, firstFaultReason,
      lockExists: await exists(join(state, '.pipeline.lock')),
      discoveryExists: await exists(join(state, 'discovery-receipt.json')) });
    return { releaseId: release.id, assets: release.assets.map(asset => ({ id: asset.id,
      name: asset.name, size: asset.size, digest: asset.digest })),
    publicAtObserved: release.draft === false, observedTime, faultTime, firstFaultReason,
    exit: { code: result.code, signal: result.signal, time: result.exitTime }, proxy: proxy.stats() };
  } catch (error) {
    proxy.fault();
    if (process && !process.status.exited && !error.message.startsWith('CLI exit deadline exceeded')) {
      await boundedExit(process, EXIT_MS);
    }
    throw error;
  } finally { await proxy.close(); }
}
