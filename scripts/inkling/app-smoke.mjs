#!/usr/bin/env node
// Starts the installed Windows app and looks at it through WebView2's remote
// debugging port: the window comes up, the interface renders, and the Rust side
// answers. With --model it also asks the app itself to start its engine on that
// file (the command the model picker calls) and reads back what the app says.
//
//   node scripts/inkling/app-smoke.mjs --exe <locally-uncensored.exe> --out <dir> [--model <file.gguf>]
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const EXE = opt('exe')
const OUT = opt('out', 'inkling-app-smoke')
const MODEL = opt('model')
const CDP_PORT = Number(opt('cdp-port', '9223'))
const START_TIMEOUT_S = Number(opt('start-timeout', '2400'))
if (!EXE) { console.error('usage: app-smoke.mjs --exe <app.exe> --out <dir> [--model <gguf>]'); process.exit(2) }
fs.mkdirSync(OUT, { recursive: true })

const report = { exe: EXE, startedAt: new Date().toISOString(), steps: [] }
let failed = false
const step = (name, ok, detail = {}) => {
  if (!ok) failed = true
  report.steps.push({ name, status: ok ? 'PASS' : 'FAIL', ...detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail.note ? ` - ${detail.note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sidecars = () => {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq lu-llama-server.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => l.includes('lu-llama-server')).length
  } catch { return -1 }
}

const app = spawn(EXE, [], {
  cwd: path.dirname(EXE),
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: 'ignore',
  detached: false,
})
let appExit = null
app.on('exit', (code) => { appExit = { code } })

let browser
try {
  let up = false
  for (let i = 0; i < 180 && !up && !appExit; i++) {
    try { up = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok } catch { await sleep(1000) }
  }
  step('App starts and its WebView answers', up, { note: up ? `pid ${app.pid}` : `no WebView after 180 s${appExit ? `, app exited with ${appExit.code}` : ''}` })
  if (!up) throw new Error('app did not start')

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  let page
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost|^tauri:/.test(p.url()))
    if (!page) await sleep(1000)
  }
  step('Main window page found', !!page, { note: page ? page.url() : 'no tauri.localhost page' })
  if (!page) throw new Error('no page')
  page.on('pageerror', (e) => { (report.pageErrors ??= []).push(String(e).slice(0, 300)) })

  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, null, { timeout: 60000 }).catch(() => {})
  await sleep(8000)
  const ui = await page.evaluate(() => ({
    title: document.title,
    rootChildren: document.getElementById('root')?.childElementCount ?? 0,
    textLength: document.body.innerText.length,
    textStart: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
    buttons: document.querySelectorAll('button').length,
    hasTauri: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
  }))
  report.ui = ui
  await page.screenshot({ path: path.join(OUT, 'app-first-launch.png') }).catch((e) => { report.screenshotError = String(e).slice(0, 200) })
  step('Interface renders', ui.rootChildren > 0 && ui.buttons > 0, { note: `title "${ui.title}", ${ui.buttons} buttons, ${ui.textLength} characters of text` })
  step('Tauri bridge present', ui.hasTauri)

  const invoke = (cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e) })), [cmd, args ?? {}])

  const status0 = await invoke('bundled_engine_status')
  report.engineStatusAtStart = status0
  step('Rust backend answers (bundled_engine_status)', status0.ok, { note: JSON.stringify(status0.ok ? status0.v : status0.e).slice(0, 300) })

  if (MODEL) {
    const t0 = Date.now()
    const started = await Promise.race([
      invoke('start_bundled_engine', { modelPath: MODEL }),
      sleep(START_TIMEOUT_S * 1000).then(() => ({ ok: false, e: `no answer within ${START_TIMEOUT_S} s` })),
    ])
    const seconds = +((Date.now() - t0) / 1000).toFixed(1)
    report.engineStart = { seconds, ...started }
    step('The app starts its engine on the model (start_bundled_engine)', started.ok, { note: `${seconds} s: ${JSON.stringify(started.ok ? started.v : started.e).slice(0, 600)}` })

    const status1 = await invoke('bundled_engine_status')
    report.engineStatusLoaded = status1
    const running = status1.ok && status1.v?.running === true && status1.v?.healthy === true
    step('The app reports the engine running and healthy', running, { note: JSON.stringify(status1.ok ? status1.v : status1.e).slice(0, 600) })
    step('lu-llama-server.exe is a running process', sidecars() > 0, { note: `${sidecars()} process(es)` })
    await page.screenshot({ path: path.join(OUT, 'app-engine-loaded.png') }).catch(() => {})

    const stopped = await invoke('stop_bundled_engine')
    report.engineStop = stopped
    await sleep(3000)
    const status2 = await invoke('bundled_engine_status')
    report.engineStatusStopped = status2
    step('The app stops its engine (stop_bundled_engine)', stopped.ok && status2.ok && status2.v?.running !== true && sidecars() === 0, { note: `${JSON.stringify(status2.ok ? status2.v : status2.e).slice(0, 200)}; ${sidecars()} engine process(es) left` })
  }
} catch (e) {
  report.error = String(e.stack ?? e).slice(0, 1500)
  if (!failed) step('App smoke run', false, { note: String(e.message ?? e).slice(0, 300) })
} finally {
  await browser?.close().catch(() => {})
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' }) } catch { /* already gone */ }
  await sleep(3000)
  const left = sidecars()
  step('No engine process is left after the app closes', left === 0, { note: `${left} lu-llama-server.exe process(es)` })
}
report.result = failed ? 'FAIL' : 'PASS'
report.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(OUT, 'app-smoke.json'), JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(OUT, 'app-smoke.md'), [`# App smoke (${path.basename(EXE)})`, '', '| Step | Result | Detail |', '|---|---|---|', ...report.steps.map((s) => `| ${s.name} | ${s.status} | ${(s.note ?? '').replace(/\|/g, '/')} |`), '', `Overall: **${report.result}**`, ''].join('\n'))
console.log(`Overall: ${report.result}`)
process.exit(failed ? 1 : 0)
