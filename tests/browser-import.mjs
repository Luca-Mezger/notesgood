// End-to-end check with disposable PDFs, browser history, and browser storage. No real notes or sync.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { handleGoodnotesImport } from '../scripts/goodnotes-import.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), 'notesgood-browser-import-'));
const importDir = join(temp, 'Downloads'), historyFile = join(temp, 'History'), inboxDir = join(temp, 'inbox');
await mkdir(importDir);
const history = new DatabaseSync(historyFile);
history.exec('CREATE TABLE downloads (target_path TEXT, tab_url TEXT, tab_referrer_url TEXT, state INTEGER)');
async function addPdf(name, title, data) {
  if (!data) { const pdf = await PDFDocument.create(); pdf.setTitle(title); pdf.addPage([595, 842]).drawText(title, { x: 45, y: 760 }); data = await pdf.save(); }
  await writeFile(join(importDir, name), data);
  history.prepare('INSERT INTO downloads VALUES (?, ?, ?, 1)').run(join(importDir, name), 'https://web.goodnotes.com/doc/demo', '');
  return data;
}
const first = await addPdf('Algebra.pdf', 'Algebra demo');
await addPdf('Physics.pdf', 'Physics demo');
await addPdf('Renamed algebra.pdf', '', first);
await writeFile(join(importDir, 'Unrelated.pdf'), first);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  if (await handleGoodnotesImport(req, res, { importDir, historyFile, inboxDir })) return;
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = join(process.cwd(), 'dist', path === '/' ? 'index.html' : path);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const profile = join(temp, 'profile');
const browser = spawn(process.env.CHROMIUM_BIN || 'chromium', ['--headless=new', '--no-first-run', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await delay(100); } }
  assert(port, 'Headless Chromium did not start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => { const message = JSON.parse(data); const entry = pending.get(message.id); if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const until = async (expression) => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(100); } throw Error('Timed out: ' + expression); };
  const importAction = async (label, condition) => {
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='From Goodnotes').click()");
    await until("!!document.querySelector('.modal .import-status')");
    await evaluate(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    if (condition) await until(condition);
    await evaluate("document.querySelector('.modal-actions .btn.primary').click()");
  };
  await send('Page.enable');
  // Hidden desktop windows stop animation frames. Imports and covers must still complete.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = () => 0;' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/' });
  await until("!!document.querySelector('[data-folder=\"Goodnotes\"]')");
  await evaluate("(()=>{const s=document.querySelector('[aria-label=\"Library view\"]');s.value='all';s.dispatchEvent(new Event('change'))})()");
  await until("document.querySelectorAll('.card').length===2");
  console.log('PASS: actual browser automatically imports two unique PDFs and skips a renamed duplicate.');
  assert.equal(await evaluate("document.querySelector('.modal-back')===null"), true, 'Auto import must not ask for margins');
  assert.equal(await evaluate("localStorage.getItem('margin.sync')"), null, 'Disposable browser must never connect to user sync');
  await send('Page.reload');
  await until("document.querySelectorAll('.card').length===2");
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 2);
  console.log('PASS: restarting the library does not reimport processed exports.');
  await importAction('Pause auto-import');
  await addPdf('Reading.pdf', 'Reading demo');
  await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await delay(500);
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 2);
  await importAction('Resume auto-import', "document.querySelectorAll('.card').length===3");
  console.log('PASS: pause blocks new imports; resume picks up the next export.');
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='From Goodnotes').click()");
  await until("!!document.querySelector('.modal-back')");
  assert((await evaluate("document.querySelector('.modal').textContent")).includes('one at a time'));
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Choose PDFs or ZIP').click()");
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file][accept]' });
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [join(importDir, 'Renamed algebra.pdf')] });
  await until("!document.querySelector('.modal-back') && document.querySelector('.toast')?.textContent.includes('already imported')");
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 3);
  console.log('PASS: visible Goodnotes import action imports immediately and detects existing content.');
  await mkdir(join(inboxDir, 'Math'), { recursive: true });
  await writeFile(join(inboxDir, 'Math', 'Algebra.pdf'), first);
  await importAction('Check now', "document.querySelector('.import-status')?.textContent.includes('1 already imported') && !!document.querySelector('[data-folder=\"Math\"]')");
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 3);
  await evaluate("document.querySelector('[data-folder=\"Math\"] .folder-open').click()");
  await until("document.querySelectorAll('.card').length===1");
  assert((await evaluate("document.querySelector('.card').textContent")).includes('Algebra'));
  console.log('PASS: private migration exports recover the original folder without duplicating an existing notebook.');
  await mkdir(join(inboxDir, 'Other course'), { recursive: true });
  await writeFile(join(inboxDir, 'Other course', 'Algebra.pdf'), first);
  await evaluate("document.querySelector('.breadcrumb[data-drop-folder=\"\"]').click()");
  await importAction('Check now', "!!document.querySelector('[data-folder=\"Other course\"]')");
  await evaluate("document.querySelector('[data-folder=\"Other course\"] .folder-open').click()");
  await until("document.querySelectorAll('.card').length===1");
  console.log('PASS: distinct migration sources keep their separate notebooks even when their PDF content is identical.');
  await evaluate(`(()=>{
    const source=document.querySelector('.card'),target=document.querySelector('.breadcrumb[data-drop-folder=""]'),dataTransfer=new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
    source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));
  })()`);
  await until("document.querySelectorAll('.card').length===0");
  await writeFile(join(inboxDir, 'Other course', 'Algebra.pdf'), first);
  await evaluate("document.querySelector('.breadcrumb[data-drop-folder=\"\"]').click()");
  await importAction('Check now', "document.querySelector('.import-status')?.textContent.includes('already imported')");
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 1, 'Auto import must retain a user-selected root folder');
  console.log('PASS: automatic reimport respects a notebook manually moved to Documents.');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/notesgood-import-check.png', Buffer.from(shot.data, 'base64'));
} finally {
  ws?.close(); browser.kill('SIGTERM'); history.close();
  await new Promise((resolve) => server.close(resolve));
  await delay(300); await rm(temp, { recursive: true, force: true });
}
