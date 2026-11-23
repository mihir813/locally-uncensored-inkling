#!/usr/bin/env node
// Real-model test of the bundled engine (lu-llama-server), started with the
// argv LU itself builds (src-tauri/src/commands/engine.rs, server_args):
// GGUF header, load, /health, streamed chat, a second turn, Stop, unload, and
// a second start. It writes a JSON and a Markdown report and exits non-zero
// when a step fails. Nothing here is mocked.
//
//   node scripts/inkling/model-test.mjs --server <lu-llama-server> --model <file.gguf> --out <dir>
//        [--cwd <dir with the ggml DLLs>] [--ngl 0] [--ctx 8192] [--port 8127]
//        [--max-tokens 96] [--load-timeout 1800] [--label "windows-latest runner"]
//        [--extra-args "--no-repack"]   (appended to the engine argv, space separated)
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const SERVER = opt('server')
const MODEL = opt('model')
const OUT = opt('out', 'inkling-model-test')
const CWD = opt('cwd', SERVER ? path.dirname(SERVER) : '.')
const NGL = opt('ngl', '0')
const CTX = opt('ctx', '8192')
const PORT = Number(opt('port', '8127'))
const MAX_TOKENS = Number(opt('max-tokens', '96'))
const LOAD_TIMEOUT_S = Number(opt('load-timeout', '1800'))
const EXTRA_ARGS = opt('extra-args', '').split(/\s+/).filter(Boolean)
const LABEL = opt('label', `${os.type()} ${os.release()}`)
if (!SERVER || !MODEL) {
  console.error('usage: model-test.mjs --server <bin> --model <gguf> --out <dir>')
  process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })

const report = {
  label: LABEL,
  startedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    totalRamGiB: +(os.totalmem() / 2 ** 30).toFixed(2),
  },
  server: SERVER,
  model: { path: MODEL },
  args: null,
  steps: [],
}
const step = (name, status, detail = {}) => {
  report.steps.push({ name, status, ...detail })
  console.log(`[${status}] ${name}${detail.note ? ` - ${detail.note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- GGUF header -----------------------------------------------------------
function readGgufHeader(file) {
  const fd = fs.openSync(file, 'r')
  let pos = 0
  const read = (n) => {
    const b = Buffer.alloc(n)
    let got = 0
    while (got < n) {
      const r = fs.readSync(fd, b, got, n - got, pos + got)
      if (r <= 0) throw new Error('unexpected end of file in the GGUF header')
      got += r
    }
    pos += n
    return b
  }
  const u32 = () => read(4).readUInt32LE(0)
  const u64 = () => Number(read(8).readBigUInt64LE(0))
  const str = () => read(u64()).toString('utf8')
  const scalar = (t) => {
    switch (t) {
      case 0: return read(1).readUInt8(0)
      case 1: return read(1).readInt8(0)
      case 2: return read(2).readUInt16LE(0)
      case 3: return read(2).readInt16LE(0)
      case 4: return u32()
      case 5: return read(4).readInt32LE(0)
      case 6: return read(4).readFloatLE(0)
      case 7: return read(1).readUInt8(0) !== 0
      case 8: return str()
      case 10: return u64()
      case 11: return Number(read(8).readBigInt64LE(0))
      case 12: return read(8).readDoubleLE(0)
      default: throw new Error(`unknown GGUF value type ${t}`)
    }
  }
  const FIXED = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
  try {
    const magic = read(4).toString('latin1')
    if (magic !== 'GGUF') throw new Error(`not a GGUF file (magic ${JSON.stringify(magic)})`)
    const version = u32()
    const tensorCount = u64()
    const kvCount = u64()
    const kv = {}
    for (let i = 0; i < kvCount; i++) {
      const key = str()
      const t = u32()
      if (t === 9) {
        const et = u32()
        const n = u64()
        if (et in FIXED) {
          pos += FIXED[et] * n
        } else if (et === 8) {
          for (let j = 0; j < n; j++) { const len = u64(); pos += len }
        } else {
          throw new Error(`unsupported GGUF array element type ${et} at ${key}`)
        }
        kv[key] = `[array of ${n}]`
        kv[`${key}#len`] = n
      } else {
        kv[key] = scalar(t)
      }
    }
    const TYPES = { 0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1', 10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K', 16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64', 29: 'IQ1_M', 30: 'BF16' }
    const tensorTypes = {}
    const sample = []
    for (let i = 0; i < tensorCount; i++) {
      const name = str()
      const nd = u32()
      const dims = []
      for (let d = 0; d < nd; d++) dims.push(u64())
      const type = u32()
      u64() // offset
      const tn = TYPES[type] ?? `type${type}`
      tensorTypes[tn] = (tensorTypes[tn] ?? 0) + 1
      if (i < 6) sample.push({ name, dims, type: tn })
    }
    return { version, tensorCount, kvCount, kv, tensorTypes, sample, headerBytes: pos }
  } finally {
    fs.closeSync(fd)
  }
}

// ---- process helpers -------------------------------------------------------
function memoryOf(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64) $($p.PrivateMemorySize64)"`], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
      return { workingSetMiB: Math.round(out[0] / 2 ** 20), peakWorkingSetMiB: Math.round(out[1] / 2 ** 20), privateMiB: Math.round(out[2] / 2 ** 20) }
    }
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    const kb = (k) => Number((s.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm')) ?? [])[1] ?? 0)
    return { workingSetMiB: Math.round(kb('VmRSS') / 1024), peakWorkingSetMiB: Math.round(kb('VmHWM') / 1024), privateMiB: Math.round(kb('RssAnon') / 1024) }
  } catch (e) {
    return { error: String(e.message ?? e).slice(0, 200) }
  }
}

const KEY = randomBytes(24).toString('hex')
const BASE = `http://127.0.0.1:${PORT}`
const auth = { Authorization: `Bearer ${KEY}` }

async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    return r.status
  } catch {
    return 0
  }
}

function startServer(tag) {
  // The argv of engine.rs server_args with the default tuning, plus -ngl.
  const args = ['-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT), '--ctx-size', CTX, '-ngl', NGL, '-lv', '4', ...EXTRA_ARGS]
  report.args = args.map((a) => (a === MODEL ? '<model>' : a))
  const logPath = path.join(OUT, `engine-${tag}.log`)
  const log = fs.createWriteStream(logPath)
  const t0 = Date.now()
  const child = spawn(SERVER, args, { cwd: CWD, env: { ...process.env, LLAMA_API_KEY: KEY }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const state = { child, t0, logPath, exited: null }
  child.on('exit', (code, signal) => { state.exited = { code, signal } })
  child.on('error', (e) => { state.exited = { code: -1, signal: null, error: String(e) } })
  return state
}

async function waitReady(s) {
  const deadline = s.t0 + LOAD_TIMEOUT_S * 1000
  while (Date.now() < deadline) {
    if (s.exited) return { ok: false, why: `engine exited during load: ${JSON.stringify(s.exited)}` }
    if ((await health()) === 200) return { ok: true, seconds: +((Date.now() - s.t0) / 1000).toFixed(1) }
    await sleep(500)
  }
  return { ok: false, why: `no /health 200 within ${LOAD_TIMEOUT_S} s` }
}

async function stopServer(s) {
  const t0 = Date.now()
  if (!s.exited) s.child.kill()
  while (!s.exited && Date.now() - t0 < 60000) await sleep(200)
  if (!s.exited) { s.child.kill('SIGKILL'); await sleep(1000) }
  let portFree = false
  for (let i = 0; i < 20 && !portFree; i++) { portFree = (await health()) === 0; if (!portFree) await sleep(250) }
  return { exited: s.exited, seconds: +((Date.now() - t0) / 1000).toFixed(1), portFree }
}

// One streamed chat request. abortAfterTokens > 0 presses "Stop" mid-stream.
async function chat(messages, { maxTokens = MAX_TOKENS, abortAfterTokens = 0 } = {}) {
  const ctl = new AbortController()
  const t0 = Date.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ messages, stream: true, max_tokens: maxTokens, temperature: 0, cache_prompt: true, timings_per_token: true }),
    signal: ctl.signal,
  })
  if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`)
  let content = ''
  let reasoning = ''
  let chunks = 0
  let firstTokenMs = null
  let timings = null
  let finish = null
  let aborted = false
  const dec = new TextDecoder()
  let buf = ''
  try {
    for await (const part of res.body) {
      buf += dec.decode(part, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        const j = JSON.parse(data)
        if (j.timings) timings = j.timings
        const c = j.choices?.[0]
        if (!c) continue
        const d = c.delta ?? {}
        if (d.content || d.reasoning_content) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0
          chunks++
          content += d.content ?? ''
          reasoning += d.reasoning_content ?? ''
        }
        if (c.finish_reason) finish = c.finish_reason
        if (abortAfterTokens > 0 && chunks >= abortAfterTokens && !aborted) {
          aborted = true
          ctl.abort()
        }
      }
    }
  } catch (e) {
    if (!aborted) throw e
  }
  return { content, reasoning, chunks, firstTokenMs, timings, finish, aborted, wallSeconds: +((Date.now() - t0) / 1000).toFixed(1) }
}

const perf = (t) => t ? {
  promptTokens: t.prompt_n, promptTokensPerSecond: t.prompt_per_second != null ? +t.prompt_per_second.toFixed(2) : null,
  cachedTokens: t.cache_n ?? null,
  generatedTokens: t.predicted_n, generatedTokensPerSecond: t.predicted_per_second != null ? +t.predicted_per_second.toFixed(2) : null,
} : null

// ---- the run ---------------------------------------------------------------
let failed = false
const fail = (name, note, extra = {}) => { failed = true; step(name, 'FAIL', { note, ...extra }) }

async function main() {
  // 1. GGUF header
  try {
    const st = fs.statSync(MODEL)
    const h = readGgufHeader(MODEL)
    report.model = {
      path: MODEL, file: path.basename(MODEL), bytes: st.size, sizeGiB: +(st.size / 2 ** 30).toFixed(2),
      ggufVersion: h.version, tensorCount: h.tensorCount, kvCount: h.kvCount,
      architecture: h.kv['general.architecture'], name: h.kv['general.name'], fileType: h.kv['general.file_type'],
      tokenizer: h.kv['tokenizer.ggml.model'], tokenizerPre: h.kv['tokenizer.ggml.pre'], vocabSize: h.kv['tokenizer.ggml.tokens#len'],
      hasChatTemplate: typeof h.kv['tokenizer.chat_template'] === 'string',
      tensorTypes: h.tensorTypes, firstTensors: h.sample,
      archKeys: Object.fromEntries(Object.entries(h.kv).filter(([k, v]) => k.startsWith(`${h.kv['general.architecture']}.`) && typeof v !== 'string' || (typeof v === 'string' && k.startsWith(`${h.kv['general.architecture']}.`) && !k.endsWith('#len')))),
    }
    step('GGUF header parsed', 'PASS', { note: `GGUF v${h.version}, architecture ${report.model.architecture}, ${h.tensorCount} tensors, ${report.model.sizeGiB} GiB` })
  } catch (e) {
    fail('GGUF header parsed', String(e.message ?? e))
    return
  }

  // 2. first load
  let s = startServer('1')
  const ready = await waitReady(s)
  if (!ready.ok) {
    fail('Model load (first start)', ready.why)
    await stopServer(s)
    return
  }
  const memLoaded = memoryOf(s.child.pid)
  step('Model load (first start)', 'PASS', { note: `/health 200 after ${ready.seconds} s`, loadSeconds: ready.seconds, memory: memLoaded })

  // 3. /props: what the engine says it loaded
  try {
    const r = await fetch(`${BASE}/props`, { headers: auth })
    const p = await r.json()
    report.props = { status: r.status, nCtx: p.default_generation_settings?.n_ctx ?? null, totalSlots: p.total_slots ?? null, modelPath: p.model_path ? path.basename(p.model_path) : null, modalities: p.modalities ?? null, buildInfo: p.build_info ?? null, chatTemplateBytes: (p.chat_template ?? '').length }
    step('Engine /props', r.ok ? 'PASS' : 'FAIL', { note: `n_ctx per slot ${report.props.nCtx}, slots ${report.props.totalSlots}, build ${report.props.buildInfo}` })
    if (!r.ok) failed = true
  } catch (e) {
    fail('Engine /props', String(e.message ?? e))
  }

  // 3b. the key is enforced, as LU expects (a request without it is refused)
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }) })
    step('Engine refuses a request without the key', r.status === 401 ? 'PASS' : 'FAIL', { note: `HTTP ${r.status}` })
    if (r.status !== 401) failed = true
    await r.arrayBuffer().catch(() => {})
  } catch (e) {
    fail('Engine refuses a request without the key', String(e.message ?? e))
  }

  // 4. first turn, streamed
  const messages = [{ role: 'user', content: 'What is the capital of France? Answer in one short sentence.' }]
  let first
  try {
    first = await chat(messages)
    const text = first.content + first.reasoning
    const ok = text.trim().length > 0
    step('Streamed generation (turn 1)', ok ? 'PASS' : 'FAIL', {
      note: ok ? `${first.chunks} stream chunks, first after ${first.firstTokenMs} ms, finish ${first.finish}` : 'the engine returned no text',
      answer: first.content.slice(0, 600), reasoning: first.reasoning.slice(0, 600), mentionsParis: /paris/i.test(text),
      perf: perf(first.timings), wallSeconds: first.wallSeconds, memory: memoryOf(s.child.pid),
    })
    if (!ok) failed = true
  } catch (e) {
    fail('Streamed generation (turn 1)', String(e.message ?? e))
  }

  // 5. second turn on the same conversation
  if (first) {
    try {
      messages.push({ role: 'assistant', content: first.content || 'Paris.' })
      messages.push({ role: 'user', content: 'And the capital of Japan? One short sentence.' })
      const second = await chat(messages)
      const text = second.content + second.reasoning
      const ok = text.trim().length > 0
      step('Streamed generation (turn 2, same conversation)', ok ? 'PASS' : 'FAIL', {
        note: ok ? `${second.chunks} stream chunks, ${second.timings?.cache_n ?? 'n/a'} prompt tokens reused from the cache` : 'the engine returned no text',
        answer: second.content.slice(0, 600), reasoning: second.reasoning.slice(0, 600), mentionsTokyo: /tokyo/i.test(text),
        perf: perf(second.timings), wallSeconds: second.wallSeconds, memory: memoryOf(s.child.pid),
      })
      if (!ok) failed = true
    } catch (e) {
      fail('Streamed generation (turn 2, same conversation)', String(e.message ?? e))
    }
  }

  // 6. Stop mid-stream, then the engine must answer again
  try {
    const stopped = await chat([{ role: 'user', content: 'Count from 1 to 200, one number per line.' }], { maxTokens: 400, abortAfterTokens: 4 })
    const tAfter = Date.now()
    const again = await chat([{ role: 'user', content: 'Say OK.' }], { maxTokens: 24 })
    const ok = stopped.aborted && (again.content + again.reasoning).trim().length > 0 && !s.exited
    step('Stop during generation, then a new request', ok ? 'PASS' : 'FAIL', {
      note: `stream cut after ${stopped.chunks} chunks; next request answered ${((Date.now() - tAfter) / 1000).toFixed(1)} s later`,
      answer: again.content.slice(0, 200), perf: perf(again.timings),
    })
    if (!ok) failed = true
  } catch (e) {
    fail('Stop during generation, then a new request', String(e.message ?? e))
  }

  // 7. unload
  const peak = memoryOf(s.child.pid)
  const stop1 = await stopServer(s)
  const unloadOk = !!stop1.exited && stop1.portFree
  step('Unload (engine stop)', unloadOk ? 'PASS' : 'FAIL', { note: `process gone after ${stop1.seconds} s, port ${PORT} ${stop1.portFree ? 'free' : 'STILL OPEN'}`, peakMemory: peak })
  if (!unloadOk) failed = true

  // 8. second start: the reload a restart of the app does
  s = startServer('2')
  const ready2 = await waitReady(s)
  if (!ready2.ok) {
    fail('Model load (second start)', ready2.why)
    await stopServer(s)
    return
  }
  try {
    const r = await chat([{ role: 'user', content: 'Write one sentence about the sea.' }], { maxTokens: Math.min(MAX_TOKENS, 64) })
    const ok = (r.content + r.reasoning).trim().length > 0
    step('Model load (second start) and generation', ok ? 'PASS' : 'FAIL', { note: `/health 200 after ${ready2.seconds} s`, loadSeconds: ready2.seconds, answer: r.content.slice(0, 400), reasoning: r.reasoning.slice(0, 300), perf: perf(r.timings), memory: memoryOf(s.child.pid) })
    if (!ok) failed = true
  } catch (e) {
    fail('Model load (second start) and generation', String(e.message ?? e))
  }
  await stopServer(s)
}

function grepLog(file, patterns) {
  try {
    const out = []
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (patterns.some((p) => p.test(line))) out.push(line.slice(0, 300))
      if (out.length >= 60) break
    }
    return out
  } catch { return [] }
}

function markdown() {
  const m = report.model
  const lines = []
  lines.push(`# Real-model test: ${m.file ?? path.basename(MODEL)}`, '')
  lines.push(`- Where: ${report.label}`)
  lines.push(`- Host: ${report.host.cpu}, ${report.host.logicalCpus} logical CPUs, ${report.host.totalRamGiB} GiB RAM, ${report.host.platform} ${report.host.osRelease}`)
  lines.push(`- Engine: \`${path.basename(SERVER)}\`${report.props?.buildInfo ? ` (${report.props.buildInfo})` : ''}`)
  lines.push(`- Engine arguments: \`${(report.args ?? []).join(' ')}\``)
  lines.push(`- Model: ${m.bytes ?? '?'} bytes (${m.sizeGiB ?? '?'} GiB), GGUF v${m.ggufVersion ?? '?'}, architecture \`${m.architecture ?? '?'}\`, ${m.tensorCount ?? '?'} tensors, tokenizer \`${m.tokenizer ?? '?'}\`${m.tokenizerPre ? ` / \`${m.tokenizerPre}\`` : ''}, vocabulary ${m.vocabSize ?? '?'}`)
  if (m.tensorTypes) lines.push(`- Tensor types: ${Object.entries(m.tensorTypes).map(([k, v]) => `${k} x${v}`).join(', ')}`)
  lines.push('', '| Step | Result | Detail |', '|---|---|---|')
  for (const s of report.steps) lines.push(`| ${s.name} | ${s.status} | ${(s.note ?? '').replace(/\|/g, '/')} |`)
  lines.push('', '## Measurements', '', '| Step | Load s | Prompt tok | Prompt tok/s | Generated tok | Generated tok/s | Working set MiB | Peak MiB |', '|---|---|---|---|---|---|---|---|')
  for (const s of report.steps) {
    if (!s.perf && !s.loadSeconds) continue
    const mem = s.memory ?? s.peakMemory ?? {}
    lines.push(`| ${s.name} | ${s.loadSeconds ?? ''} | ${s.perf?.promptTokens ?? ''} | ${s.perf?.promptTokensPerSecond ?? ''} | ${s.perf?.generatedTokens ?? ''} | ${s.perf?.generatedTokensPerSecond ?? ''} | ${mem.workingSetMiB ?? ''} | ${mem.peakWorkingSetMiB ?? ''} |`)
  }
  lines.push('', '## What the model wrote', '')
  for (const s of report.steps) {
    if (s.answer === undefined) continue
    lines.push(`**${s.name}**`, '')
    if (s.reasoning) lines.push('Reasoning:', '', '```', s.reasoning, '```', '')
    lines.push('Answer:', '', '```', s.answer || '(empty)', '```', '')
  }
  if (report.engineLog?.length) lines.push('## Engine log excerpt (first start)', '', '```', ...report.engineLog, '```', '')
  lines.push(`Overall: **${report.result}**`, '')
  return lines.join('\n')
}

try {
  await main()
} catch (e) {
  fail('Test run', String(e.stack ?? e))
}
report.engineLog = grepLog(path.join(OUT, 'engine-1.log'), [/general\.architecture/, /arch\s+=/, /file type/, /file size/, /model params/, /n_layer\s/, /n_expert/, /vocab type/, /load_backend/, /system_info/, /offloaded \d+/, /unknown model architecture/, /error/i, /model loaded/, /n_ctx_slot|n_ctx\s+=/, /BOS token|EOS token/, /chat template/i])
report.finishedAt = new Date().toISOString()
report.result = failed ? 'FAIL' : 'PASS'
fs.writeFileSync(path.join(OUT, 'model-test.json'), JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(OUT, 'model-test.md'), markdown())
console.log(`\nOverall: ${report.result}. Report: ${path.join(OUT, 'model-test.md')}`)
process.exit(failed ? 1 : 0)
