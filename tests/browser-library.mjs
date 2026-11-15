// Disposable browser/storage only. Never connects to the user's notes or sync server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), 'notesgood-library-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
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
  const pending = new Map(), exceptions = [];
  let nativeDrag;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data), entry = pending.get(message.id);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    if (message.method === 'Input.dragIntercepted') nativeDrag = message.params.data;
    if (entry) { pending.delete(message.id); message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); } throw Error('Timed out: ' + expression); };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const chooseView = (value) => evaluate(`(()=>{const s=document.querySelector('[aria-label="Library view"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change'))})()`);
  const drag = async (from, to) => {
    const payload = await evaluate(`(()=>{
      const source=document.querySelector(${JSON.stringify(from)}), target=document.querySelector(${JSON.stringify(to)});
      if(!source||!target)throw Error('Drag source or destination missing');
      const dataTransfer=new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
      target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));
      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
      source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));
      return dataTransfer.getData('application/x-notesgood-library');
    })()`);
    assert(payload, 'The card must supply a draggable library item');
  };
  const mouseDrag = async (from, to) => {
    const points = await evaluate(`(()=>{
      window.scrollTo(0,0);
      const a=document.querySelector(${JSON.stringify(from)}).getBoundingClientRect(),b=document.querySelector(${JSON.stringify(to)}).getBoundingClientRect();
      return {x:a.x+a.width/2,y:a.y+30,targetX:b.x+b.width/2,targetY:b.y+b.height/2};
    })()`);
    assert(points.y < 1050 && points.targetY < 1050);
    await send('Input.setInterceptDrags', { enabled: true });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x, y: points.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.x, y: points.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x + 30, y: points.y + 10, button: 'left', buttons: 1 });
    for (let i = 0; i < 30 && !nativeDrag; i++) await delay(50);
    assert(nativeDrag?.items.some((item) => item.mimeType === 'application/x-notesgood-library'), 'A real mouse drag must expose the notebook payload');
    for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: points.targetX, y: points.targetY, data: nativeDrag });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.targetX, y: points.targetY, button: 'left', clickCount: 1 });
    await send('Input.setInterceptDrags', { enabled: false });
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('goodnotes.auto','off');
    window.readRecord=(store,key)=>new Promise((resolve,reject)=>{
      const open=indexedDB.open('margin');open.onerror=()=>reject(open.error);open.onsuccess=()=>{
        const db=open.result,q=db.transaction(store).objectStore(store).get(key);
        q.onsuccess=()=>{db.close();resolve(q.result)};q.onerror=()=>reject(q.error);
      };
    });` });
  await send('Page.navigate', { url: base });
  await until("!!document.querySelector('.library')");
  await evaluate(`(async()=>{
    const d=await new Promise((r,j)=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
    const t=d.transaction(['notebooks','pages','blobs','meta'],'readwrite');
    let i=0;
    for(const [folder,count] of [['Algorithms',14],['Algorithms / Peer review',3],['Linear algebra',9],['Discrete maths',13],['Programming',3],['Goodnotes',13]]){
      for(let n=0;n<count;n++,i++){
        const id='note-'+i;
        t.objectStore('notebooks').put({id,title:'Note '+(i+1),folder,fav:i===0,created:1000+i,updated:2000-i,pages:['page-'+i],margin:0,marginTpl:'blank',tpl:'lined',paper:'#fff',importHash:'hash-'+i,...(folder==='Goodnotes'?{}:{importSourceId:'inbox/'+folder+'/Note '+i+'.pdf'})});
        t.objectStore('pages').put({id:'page-'+i,nb:id,w:595,h:842,bg:{k:'paper',tpl:'lined',color:'#fff'},els:[{t:'s',id:'ink-'+i,k:'pen',c:'#123456',s:2,p:new Float32Array([10,20,.8,30,40,.9]),bb:[8,18,32,42]}]});
      }
    }
    t.objectStore('blobs').put(new Blob(['unchanged PDF and image bytes']),'sentinel');
    t.objectStore('meta').put(['Algorithms','Algorithms / Peer review','Linear algebra','Discrete maths','Programming','Goodnotes'],'folders');
    await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)});d.close();
  })()`);
  await send('Page.reload');
  await until("document.querySelectorAll('.folder-card').length===4");
  assert.deepEqual((await evaluate("[...document.querySelectorAll('.folder-card')].map(e=>e.dataset.folder)")).sort(), ['Algorithms', 'Discrete maths', 'Linear algebra', 'Programming']);
  assert.equal(await evaluate("document.querySelectorAll('.chips,.chip').length"), 0);
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 0);
  assert.match(await evaluate("document.querySelector('.earlier-imports').textContent"), /13 notebooks/);
  console.log('PASS: Documents shows four large folders; previous imports remain separately accessible.');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/notesgood-folders-desktop.png', Buffer.from(shot.data, 'base64'));

  await click('[data-folder="Algorithms"] .folder-open');
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 14);
  assert.equal(await evaluate("document.querySelector('.folder-card').dataset.folder"), 'Algorithms / Peer review');
  await click('[data-folder="Algorithms / Peer review"] .folder-open');
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 3);
  await send('Page.reload');
  await until("document.querySelector('.library-title')?.textContent==='Peer review'");
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 3);
  console.log('PASS: nested Peer review opens inside Algorithms, and navigation survives reload.');

  await chooseView('all');
  assert.equal(await evaluate("document.querySelectorAll('.card').length"), 55);
  await evaluate("(()=>{const s=document.querySelector('[aria-label=\"Sort by\"]');s.value='title';s.dispatchEvent(new Event('change'))})()");
  assert.equal(await evaluate("document.querySelector('.card h3').textContent.replace('★ ','')"), 'Note 1');
  await click('.sort-controls .ibtn');
  assert.equal(await evaluate("document.querySelector('.card h3').textContent"), 'Note 55');
  await send('Page.reload');
  await until("document.querySelectorAll('.card').length===55");
  assert.equal(await evaluate("document.querySelector('.card h3').textContent"), 'Note 55');
  console.log('PASS: natural name sorting, direction, and chosen view persist after restart.');

  for (const [value, title] of [['created', 'Note 55'], ['updated', 'Note 1']]) {
    await evaluate(`(()=>{const s=document.querySelector('[aria-label="Sort by"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change'))})()`);
    assert.equal(await evaluate("document.querySelector('.card h3').textContent.replace('★ ','')"), title);
  }
  await evaluate("(()=>{const s=document.querySelector('[aria-label=\"Sort by\"]');s.value='title';s.dispatchEvent(new Event('change'))})()");
  const before = await evaluate("(async()=>JSON.stringify(await readRecord('pages','page-0')))()");
  await mouseDrag('[data-notebook="note-0"] .cover', '[data-folder="Linear algebra"]');
  await until("(async()=> (await readRecord('notebooks','note-0')).folder==='Linear algebra')()");
  assert.equal(await evaluate("(async()=>JSON.stringify(await readRecord('pages','page-0')))()"), before);
  assert.equal(await evaluate("(async()=>!!(await readRecord('dirty','n:note-0')))()"), true);
  assert.equal(await evaluate("(async()=>(await readRecord('notebooks','note-0')).folderMoved)()"), true);
  await click('[data-folder="Linear algebra"] .folder-open');
  await drag('[data-notebook="note-0"]', '.breadcrumb[data-drop-folder=""]');
  await until("(async()=> (await readRecord('notebooks','note-0')).folder==='')()");
  console.log('PASS: real mouse drag moves a notebook; dropping on Documents moves it back, preserving ink and marking sync metadata.');

  await chooseView('folder');
  await drag('[data-folder="Algorithms"]', '[data-folder="Programming"]');
  await until("(async()=> (await readRecord('notebooks','note-1')).folder==='Programming / Algorithms')()");
  assert.equal(await evaluate("(async()=>(await readRecord('notebooks','note-14')).folder)()"), 'Programming / Algorithms / Peer review');
  await click('[data-folder="Programming"] .folder-open');
  await drag('[data-folder="Programming / Algorithms"]', '.breadcrumb[data-drop-folder=""]');
  await until("(async()=> (await readRecord('notebooks','note-14')).folder==='Algorithms / Peer review')()");
  console.log('PASS: folder drops move the complete subtree and can restore it to the root.');

  await chooseView('folder');
  await click('[data-folder="Algorithms"] .folder-more');
  await evaluate("[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='Rename folder').click()");
  await evaluate("document.querySelector('.modal input').value='Algorithms renamed'");
  await click('.modal-actions .primary');
  await until("(async()=> (await readRecord('notebooks','note-14')).folder==='Algorithms renamed / Peer review')()");
  assert.equal(await evaluate("(async()=>JSON.stringify(await readRecord('pages','page-0')))()"), before);
  console.log('PASS: folder rename updates the subtree while retaining notebook/page identity.');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("window.scrollTo(0,0)");
  assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'), true, 'Mobile layout must not overflow');
  const mobile = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/notesgood-folders-mobile.png', Buffer.from(mobile.data, 'base64'));
  assert.equal(await evaluate("(async()=>(await readRecord('blobs','sentinel')).text())()"), 'unchanged PDF and image bytes');
  assert.equal(await evaluate("localStorage.getItem('margin.sync')"), null);
  assert.deepEqual(exceptions, [], 'No uncaught browser exceptions');
  console.log('PASS: responsive layout, notebook/page/blob retention, no connection to private sync.');

  const pdf = await PDFDocument.create();
  for (let i = 0; i < 8; i++) pdf.addPage([595, 842]).drawRectangle({ x: 20 + i, y: 20, width: 10, height: 10 });
  const encoded = Buffer.from(await pdf.save()).toString('base64');
  await evaluate(`(()=>{
    const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));
    const dataTransfer=new DataTransfer();dataTransfer.items.add(new File([bytes],'Dropped demo.pdf',{type:'application/pdf'}));
    document.querySelector('[data-folder="Linear algebra"]').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
  })()`);
  await until("document.querySelector('.modal h2')?.textContent==='Import PDF'");
  await click('.modal-actions .primary');
  await until("!!document.querySelector('.editor')");
  assert.equal(await evaluate("(async()=>{const id=decodeURIComponent(location.hash.slice(4));return (await readRecord('notebooks',id)).folder})()"), 'Linear algebra');
  console.log('PASS: a PDF dropped onto a folder imports into that folder.');

  const pdfId = await evaluate('decodeURIComponent(location.hash.slice(4))');
  const readView = () => evaluate(`(()=>{const v=document.querySelector('.viewport');return {top:v.scrollTop,left:v.scrollLeft,zoom:Number(document.querySelector('.pages').style.getPropertyValue('--z'))}})()`);
  const assertView = async (expected) => {
    const actual = await readView();
    assert(Math.abs(actual.top - expected.top) < 2, `Vertical position changed: ${JSON.stringify({ actual, expected })}`);
    assert(Math.abs(actual.left - expected.left) < 2, 'Horizontal position changed');
    assert(Math.abs(actual.zoom - expected.zoom) < 0.0001, 'Zoom changed');
  };
  const openPdf = async () => {
    await chooseView('all');
    await click(`[data-notebook="${pdfId}"] .cover`);
    await until("document.querySelectorAll('.page').length===8");
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await click('.zoom');
  const expected = await evaluate(`(()=>{
    for(let i=0;i<2;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'+',ctrlKey:true,bubbles:true}));
    const v=document.querySelector('.viewport');
    v.scrollTop=document.querySelectorAll('.page')[5].offsetTop+157;v.scrollLeft=180;
    const state={top:v.scrollTop,left:v.scrollLeft,zoom:Number(document.querySelector('.pages').style.getPropertyValue('--z'))};
    document.querySelector('[aria-label="Back to library"]').click();
    return state;
  })()`);
  assert(expected.top > 2000 && expected.left > 0, 'Fixture must really scroll and pan');
  await until("!!document.querySelector('.library')");
  await chooseView('all');
  await click('[data-notebook="note-0"] .cover');
  await until("!!document.querySelector('.editor')");
  assert.equal((await readView()).top, 0, 'Another notebook must not inherit this PDF position');

  await evaluate(`localStorage.setItem('margin.recog',JSON.stringify({key:'test-claude-key',model:'claude-opus-5-5'}))`);
  await click('[aria-label="Settings"]');
  const setRecognition = (label, value, event = 'change') => evaluate(`(()=>{
    const field=document.querySelector('[aria-label="Recognition ${label}"]');field.value=${JSON.stringify(value)};field.dispatchEvent(new Event(${JSON.stringify(event)}));
  })()`);
  const recognitionField = (label) => evaluate(`document.querySelector('[aria-label="Recognition ${label}"]').value`);
  assert.equal(await recognitionField('provider'), 'claude');
  assert.equal(await recognitionField('model'), 'claude-opus-5-5');
  await setRecognition('provider', 'openai');
  assert.equal(await recognitionField('API key'), '', 'Claude key must not be reused for OpenAI');
  assert.deepEqual(await evaluate(`[...document.querySelector('[aria-label="Recognition model"]').options].map(o=>o.value)`), ['gpt-5.4-mini', 'gpt-5.4']);
  await setRecognition('API key', 'test-openai-key', 'input');
  await setRecognition('model', 'gpt-5.4');
  await setRecognition('provider', 'claude');
  assert.equal(await recognitionField('API key'), 'test-claude-key');
  assert.equal(await recognitionField('model'), 'claude-opus-5-5');
  await setRecognition('provider', 'openai');
  assert.equal(await recognitionField('API key'), 'test-openai-key');
  assert.equal(await recognitionField('model'), 'gpt-5.4');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await send('Page.reload');
  await until("!!document.querySelector('.editor')");
  await click('[aria-label="Settings"]');
  assert.equal(await recognitionField('provider'), 'openai');
  assert.equal(await recognitionField('model'), 'gpt-5.4');
  assert.equal(await recognitionField('API key'), 'test-openai-key');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  console.log('PASS: recognition settings migrate Claude, switch providers without mixing keys, and persist OpenAI model/key across reload.');

  await evaluate(`(()=>{
    const original=window.fetch;window.recognitionRequests=[];
    window.fetch=async(url,init)=>{
      if(String(url).startsWith('https://api.openai.com/')){
        window.recognitionRequests.push({url,headers:init.headers,body:JSON.parse(init.body)});
        return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'x^2 + y^2 = 1'}]}]});
      }
      return original(url,init);
    };
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'l',bubbles:true}));
  })()`);
  const point = await evaluate(`(()=>{const r=document.querySelector('.page').getBoundingClientRect(),z=Number(document.querySelector('.pages').style.getPropertyValue('--z'));return {x:r.x+20*z,y:r.y+30*z}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await until(`!!document.querySelector('[title="Handwritten maths → rendered LaTeX"]')`);
  const storedInk = await evaluate("readRecord('pages','page-0').then(p=>p.els)");
  await click('[title="Handwritten maths → rendered LaTeX"]');
  await until("!!document.querySelector('.page .katex')");
  const request = await evaluate('window.recognitionRequests[0]');
  assert.equal(request.headers.Authorization, 'Bearer test-openai-key');
  assert.equal(request.body.model, 'gpt-5.4');
  assert.equal(request.body.store, false);
  assert.match(request.body.input[0].content[0].image_url, /^data:image\/png;base64,/);
  const shortcut = (key, extra = {}) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,...${JSON.stringify(extra)}}))`);
  const tap = async p => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  };
  const formulaPoint = () => evaluate("(()=>{const r=document.querySelector('.obj.tex').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const assertFormula = async source => {
    assert.equal(await evaluate("document.querySelectorAll('.obj.tex').length"), 1, 'Undo must never leave duplicate formulas');
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    await until(`readRecord('pages','page-0').then(p=>p.els.length===1&&p.els[0].src===${JSON.stringify(source)})`);
  };
  assert.equal(await evaluate("[...document.querySelectorAll('.optbar button')].some(b=>b.textContent==='Restore handwriting')"), true);
  await shortcut('m');
  await tap(await formulaPoint());
  await click('[aria-label="Edit selected object"]');
  await until("!!document.querySelector('.tex-panel textarea')");
  await evaluate("(()=>{const t=document.querySelector('.tex-panel textarea');t.value='x^2 + y^2 = 2';t.dispatchEvent(new Event('input'))})()");
  await click('.tex-panel .primary');
  await shortcut('z', { ctrlKey: true });
  await assertFormula('x^2 + y^2 = 1');
  await shortcut('z', { ctrlKey: true });
  await until("!document.querySelector('.page .katex')");
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  await until("readRecord('pages','page-0').then(p=>p.els.length===1&&p.els[0].t==='s')");
  assert.deepEqual(await evaluate("readRecord('pages','page-0').then(p=>p.els)"), storedInk, 'Undo editing and then conversion must restore the original ink exactly, with no stray formula');
  await shortcut('y', { ctrlKey: true });
  await shortcut('y', { ctrlKey: true });
  await assertFormula('x^2 + y^2 = 2');
  assert.equal(await evaluate('window.recognitionRequests.length'), 1);
  console.log('PASS: editing a recognized formula, undoing both actions and redoing them restores exact snapshots without duplicates or another API request.');

  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  await chooseView('all');
  await click('[data-notebook="note-0"] .cover');
  await until("!!document.querySelector('.obj.tex')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Undo (Ctrl+Z)\"]').disabled"), false);
  await shortcut('z', { ctrlKey: true });
  await shortcut('z', { ctrlKey: true });
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  await until("readRecord('meta','history:note-0').then(h=>h.redo.length===2)");
  await send('Page.reload');
  await until("!!document.querySelector('.editor')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Redo (Ctrl+Shift+Z)\"]').disabled"), false);
  await shortcut('y', { ctrlKey: true });
  await shortcut('y', { ctrlKey: true });
  await assertFormula('x^2 + y^2 = 2');
  console.log('PASS: undo and redo survive leaving the notebook and restarting the app offline.');

  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  const recognized = await evaluate("readRecord('pages','page-0').then(p=>p.els[0])");
  assert.deepEqual(recognized.handwriting.ink[0].p, Object.values(storedInk[0].p));
  assert.deepEqual(JSON.parse(JSON.stringify(recognized)).handwriting, recognized.handwriting, 'Original ink remains lossless in the JSON used by sync and backups');
  // An edit from another device invalidates local undo, but the formula's ink travels with it.
  await evaluate(`(async()=>{
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    const t=d.transaction('pages','readwrite'),s=t.objectStore('pages'),q=s.get('page-0');
    q.onsuccess=()=>{const p=q.result;p.u+=1000;s.put(p)};
    await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)});d.close();
  })()`);
  await click('[data-notebook="note-0"] .cover');
  await until("!!document.querySelector('.obj.tex')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Undo (Ctrl+Z)\"]').disabled"), true, 'Never replay stale undo over edits from another device');
  await shortcut('m');
  await tap(await formulaPoint());
  await click('[aria-label="Edit selected object"]');
  await until("!!document.querySelector('.tex-panel textarea')");
  await evaluate("[...document.querySelectorAll('.tex-panel button')].find(b=>b.textContent==='Restore handwriting').click()");
  assert.equal(await evaluate("document.querySelectorAll('.obj.tex').length"), 0);
  await shortcut('z', { ctrlKey: true });
  await assertFormula('x^2 + y^2 = 2');
  await shortcut('y', { ctrlKey: true });
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  await until("readRecord('pages','page-0').then(p=>p.els.length===1&&p.els[0].t==='s')");
  const restoredInk = await evaluate("readRecord('pages','page-0').then(p=>p.els[0])");
  assert.deepEqual({ ...restoredInk, id: storedInk[0].id }, storedInk[0], 'Restoring handwriting after losing local undo recovers every original sample and style');
  await shortcut('l');
  console.log('PASS: saved original handwriting can always be restored from the formula editor, even with no local undo history, and corrected or converted again.');

  const penGesture = async (from, to = from) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', pointerType: 'pen', force: 0.5, clickCount: 1 });
    if (to !== from) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', pointerType: 'pen', force: 0, clickCount: 1 });
  };
  await penGesture(point);
  await until("!!document.querySelector('.selbox')");
  const selectionPosition = () => evaluate("(()=>{const r=document.querySelector('.selbox').getBoundingClientRect();return {x:r.x,y:r.y}})()");
  const initialSelection = await selectionPosition();
  const beforeMoves = await evaluate("readRecord('pages','page-0').then(p=>p.els)");
  let from = point;
  for (const [dx, dy] of [[100, 60], [70, 50], [-30, 20]]) {
    const to = { x: from.x + dx, y: from.y + dy };
    const previous = await selectionPosition();
    await penGesture(from, to);
    assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"), 'select');
    const next = await selectionPosition();
    assert(Math.abs(next.x - previous.x - dx) < 2 && Math.abs(next.y - previous.y - dy) < 2, 'Every pen drag must move the still-marked selection: ' + JSON.stringify({ previous, next, dx, dy, from, to }));
    from = to;
  }
  assert((await selectionPosition()).x > initialSelection.x + 100);
  for (let i = 0; i < 3; i++) await shortcut('z', { ctrlKey: true });
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  await until(`readRecord('pages','page-0').then(p=>JSON.stringify(p.els)===${JSON.stringify(JSON.stringify(beforeMoves))})`);
  for (let i = 0; i < 3; i++) await shortcut('y', { ctrlKey: true });
  await penGesture(from);
  assert(Math.abs((await selectionPosition()).x - initialSelection.x - 140) < 2, 'Repeated movement must remain undoable and redoable without mutating earlier snapshots');
  await penGesture({ x: point.x + 300, y: point.y + 220 });
  assert.equal(await evaluate("document.querySelectorAll('.selbox').length"), 0);
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"), 'pen');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'l',bubbles:true}))`);
  await penGesture({ x: point.x + 300, y: point.y + 220 }, { x: point.x + 340, y: point.y + 250 });
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"), 'select', 'Releasing an empty lasso gesture must keep the lasso active');
  await penGesture({ x: point.x + 300, y: point.y + 220 });
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"), 'pen');
  console.log('PASS: lasso release keeps the tool/selection active across repeated moves; only tapping blank space returns to the pen.');

  const toolKey = (key) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`);
  await toolKey('l');
  const hoverPoint = { x: point.x + 300, y: point.y + 220 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...hoverPoint, button: 'middle', pointerType: 'pen', force: 0, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...hoverPoint, button: 'middle', pointerType: 'pen', force: 0, clickCount: 1 });
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"), 'select', 'A hovering pen button is not a blank-page tap and must not exit lasso');
  await toolKey('p');
  const loop = [
    { x: from.x - 45, y: from.y - 45 }, { x: from.x + 45, y: from.y - 45 },
    { x: from.x + 45, y: from.y + 45 }, { x: from.x - 45, y: from.y + 45 },
    { x: from.x - 45, y: from.y - 45 },
  ];
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...loop[0], button: 'left', pointerType: 'pen', force: 0, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...loop[1], button: 'left', buttons: 1, pointerType: 'pen', force: 0 });
  // The physical button bridge can deliver its shortcut just after tip-down.
  await toolKey('l');
  for (const p of loop.slice(2)) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'left', buttons: 1, pointerType: 'pen', force: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...loop[4], button: 'left', pointerType: 'pen', force: 0, clickCount: 1 });
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"), 'select');
  assert.equal(await evaluate("document.querySelectorAll('.selbox').length"), 1, 'A delayed lasso shortcut must select ink with the same gesture, including on zero-pressure XWayland devices');
  await penGesture(hoverPoint);
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"), 'pen');
  console.log('PASS: hover button clicks keep lasso active, and a late button shortcut turns the current pen gesture into a working lasso.');
  const cursor = () => evaluate("decodeURIComponent(getComputedStyle(document.querySelector('.viewport')).cursor)");
  await toolKey('p');
  assert.match(await cursor(), /data:image\/svg\+xml/);
  assert.doesNotMatch(await cursor(), /crosshair/);
  await evaluate(`document.querySelector('.optbar .swatch[aria-label="Colour #d92d20"]').click()`);
  assert.match(await cursor(), /fill=["']#d92d20["']/);
  await toolKey('h');
  await evaluate(`document.querySelector('.optbar .swatch[aria-label="Colour #7cc4ff"]').click()`);
  assert.match(await cursor(), /fill=["']#7cc4ff["']/);
  await toolKey('e');
  assert.match(await cursor(), /fill=["']none["']/);
  await toolKey('v');
  assert.equal(await cursor(), 'grab');
  console.log('PASS: pen and highlighter have colored dot cursors; eraser has a small ring, and pan keeps its grab cursor.');

  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  await openPdf(); await assertView(expected);
  console.log('PASS: leaving immediately after scrolling restores the exact PDF position, pan and zoom; notebooks keep separate positions.');

  await send('Page.reload');
  await until("document.querySelectorAll('.page').length===8");
  await assertView(expected);
  const hiddenPosition = await evaluate(`(()=>{
    const v=document.querySelector('.viewport');v.scrollTop+=123;
    window.dispatchEvent(new Event('pagehide'));
    return {top:v.scrollTop,left:v.scrollLeft,zoom:Number(document.querySelector('.pages').style.getPropertyValue('--z'))};
  })()`);
  await send('Page.reload');
  await until("document.querySelectorAll('.page').length===8");
  await assertView(hiddenPosition);
  console.log('PASS: page reload and closing/backgrounding the page retain the saved reading position.');

  const shiftedPageHeight = await evaluate("document.querySelectorAll('.page')[1].offsetTop-document.querySelectorAll('.page')[0].offsetTop");
  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  await evaluate(`(async()=>{
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    const t=d.transaction('notebooks','readwrite'),store=t.objectStore('notebooks'),q=store.get(${JSON.stringify(pdfId)});
    q.onsuccess=()=>{const nb=q.result;nb.pages.push(nb.pages.shift());store.put(nb)};
    await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)});d.close();
  })()`);
  await openPdf();
  await assertView({ ...hiddenPosition, top: hiddenPosition.top - shiftedPageHeight });
  console.log('PASS: reordering earlier pages still restores the same document point by page identity.');

  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  await evaluate(`localStorage.setItem('notesgood.position.'+${JSON.stringify(pdfId)},'invalid saved data')`);
  await openPdf();
  assert.equal((await readView()).top, 0, 'Invalid saved state must fall back to the first page');

  await toolKey('p');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 5, radiusY: 5, force: 0.5 })) });
  await evaluate("document.querySelector('.viewport').scrollTop=400");
  const fingerStart = await readView();
  // A palm is present before the pen lands. It must stop controlling the page.
  await touch('touchStart', [[1, 450, 400]]);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 300, button: 'left', pointerType: 'pen', force: 0.5 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 340, button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
  await touch('touchMove', [[1, 450, 350]]);
  assert.equal((await readView()).top, fingerStart.top, 'A resting palm must not scroll during a pen stroke');
  await touch('touchEnd', []);
  // A deliberate finger lands just before pen-up, then moves immediately.
  await touch('touchStart', [[2, 450, 400]]);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 340, button: 'left', pointerType: 'pen', force: 0 });
  await touch('touchMove', [[2, 450, 340]]);
  assert((await readView()).top > fingerStart.top + 40, 'The very first finger move after pen-up must scroll');
  await touch('touchEnd', []);
  console.log('PASS: a palm cannot move the page during writing; an overlapping finger scrolls on its first move after pen-up.');

  await evaluate("document.querySelector('.viewport').scrollTop=400");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 300, button: 'left', pointerType: 'pen', force: 0.5 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 340, button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
  await touch('touchStart', [[3, 450, 400], [4, 650, 400]]);
  const beforePinch = await readView();
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 340, button: 'left', pointerType: 'pen', force: 0 });
  await touch('touchMove', [[3, 410, 400], [4, 690, 400]]);
  assert((await readView()).zoom > beforePinch.zoom * 1.2, 'An overlapping pinch must zoom immediately after pen-up');
  await touch('touchCancel', []);
  const afterCancel = await readView();
  await touch('touchStart', [[5, 450, 400]]);
  await touch('touchMove', [[5, 450, 340]]);
  assert((await readView()).top > afterCancel.top + 40, 'A fresh finger must pan immediately after a canceled pinch');
  await touch('touchEnd', []);
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  await until(`(async()=>{const nb=await readRecord('notebooks',${JSON.stringify(pdfId)});let count=0;for(const id of nb.pages)count+=(await readRecord('pages',id)).els.filter(e=>e.t==='s').length;return count===2})()`);
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  console.log('PASS: an overlapping pinch reacts immediately, canceled gestures do not block the next pan, and both written strokes survive.');

  const originalPages = await evaluate(`(async()=>{const nb=await readRecord('notebooks',${JSON.stringify(pdfId)});return Promise.all(nb.pages.map(id=>readRecord('pages',id)))})()`);
  const pageOrder = originalPages.map(p => p.id);
  const newPages = [];
  await click('[aria-label="Pages"]');
  const insertBlank = async (index, side, button = '.toolbar [aria-label="Add blank page"]') => {
    await click(`.thumb[data-i="${index}"]`);
    await until(`document.querySelector('.thumb.current')?.dataset.i==='${index}'`);
    await click(button);
    // Even if the viewport moves with the menu open, insert beside the chosen page.
    await evaluate("document.querySelector('.viewport').scrollTop+=500");
    await delay(50);
    await evaluate(`[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='Blank page ${side}').click()`);
    const at = index + (side === 'after' ? 1 : 0);
    await until(`document.querySelectorAll('.page').length===${pageOrder.length + 1}`);
    const nb = await evaluate(`readRecord('notebooks',${JSON.stringify(pdfId)})`);
    const id = nb.pages[at];
    assert(!pageOrder.includes(id), 'Insertion must create a new page, preserving every existing page');
    pageOrder.splice(at, 0, id);
    assert.deepEqual(nb.pages, pageOrder);
    const page = await evaluate(`readRecord('pages',${JSON.stringify(id)})`);
    assert.deepEqual(page.bg, { k: 'paper', tpl: 'blank', color: nb.paper });
    assert.deepEqual(page.els, []);
    assert.equal(page.w, 595, 'Blank pages match the PDF itself, without its extra writing margin');
    assert.equal(page.h, 842);
    assert.equal(await evaluate(`readRecord('dirty',${JSON.stringify('p:' + id)}).then(Boolean)`), true);
    assert.equal(await evaluate(`readRecord('dirty',${JSON.stringify('n:' + pdfId)}).then(Boolean)`), true);
    assert.equal(await evaluate("document.querySelector('.thumb.current').dataset.i"), String(at), 'Jump to the inserted page');
    newPages.push(page);
    return id;
  };
  await insertBlank(0, 'before');
  const middleId = await insertBlank(4, 'after', '.thumb-actions [aria-label="Add blank page"]');
  await insertBlank(pageOrder.length - 1, 'after');
  const afterInsert = await evaluate(`(async()=>Promise.all(${JSON.stringify(originalPages.map(p=>p.id))}.map(id=>readRecord('pages',id))))()`);
  assert.deepEqual(afterInsert, originalPages, 'Inserting pages must preserve original PDF references and existing ink exactly');
  assert.equal(await evaluate(`(async()=>{const b=await readRecord('blobs',${JSON.stringify(originalPages[0].bg.blob)});const a=new Uint8Array(await b.arrayBuffer());return btoa(String.fromCharCode(...a))})()`), encoded, 'The original PDF bytes stay untouched');
  console.log('PASS: insert truly blank pages before the first, between PDF pages, and after the last; originals and sync markers are preserved.');

  await click(`.thumb[data-i="${pageOrder.indexOf(middleId)}"]`);
  await click('.zoom');
  await toolKey('p');
  const writingPoint = await evaluate(`(()=>{const r=document.querySelectorAll('.page')[${pageOrder.indexOf(middleId)}].getBoundingClientRect();return {x:r.left+100,y:r.top+100}})()`);
  await penGesture(writingPoint, { x: writingPoint.x + 40, y: writingPoint.y + 40 });
  // Leaving immediately also flushes the new page's ink before reopening.
  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  await chooseView('all');
  await click(`[data-notebook="${pdfId}"] .cover`);
  await until(`document.querySelectorAll('.page').length===${pageOrder.length}`);
  await send('Page.reload');
  await until(`document.querySelectorAll('.page').length===${pageOrder.length}`);
  assert.deepEqual(await evaluate(`readRecord('notebooks',${JSON.stringify(pdfId)}).then(nb=>nb.pages)`), pageOrder);
  assert.equal(await evaluate(`readRecord('pages',${JSON.stringify(middleId)}).then(p=>p.els.length)`), 1, 'You can write on inserted pages and reopen them with their ink intact');
  for (const page of newPages.filter(p => p.id !== middleId)) assert.deepEqual(await evaluate(`readRecord('pages',${JSON.stringify(page.id)})`), page);
  console.log('PASS: inserted pages, their order and new handwriting survive leaving the notebook and restarting the app without sync.');

  await evaluate(`(()=>{
    const original=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){
      if(this.download&&this.href.startsWith('blob:')){
        window.exportedPdf=fetch(this.href).then(r=>r.arrayBuffer()).then(b=>btoa(String.fromCharCode(...new Uint8Array(b))));
      }else original.call(this);
    };
  })()`);
  await click('[aria-label="Export"]');
  await evaluate("[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='Export as PDF').click()");
  await until('!!window.exportedPdf');
  const exported = await PDFDocument.load(Buffer.from(await evaluate('window.exportedPdf'), 'base64'));
  assert.equal(exported.getPageCount(), pageOrder.length, 'Export includes every inserted page');
  for (const page of newPages) assert.deepEqual(exported.getPage(pageOrder.indexOf(page.id)).getSize(), { width: 595, height: 842 });
  console.log('PASS: PDF export includes all inserted pages at their intended positions and sizes.');

  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  await chooseView('all');
  await evaluate(`(async()=>{
    const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillRect(0,0,8,8);
    const blob=await new Promise(r=>c.toBlob(r));
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    const t=d.transaction(['pages','blobs'],'readwrite'),s=t.objectStore('pages'),q=s.get('page-54');
    q.onsuccess=()=>{const p=q.result;p.els.push(
      {t:'x',id:'mouse-formula',x:120,y:100,c:'#123456',fs:22,src:'x^2'},
      {t:'t',id:'mouse-text',x:120,y:200,c:'#123456',fs:20,text:'Click to select'},
      {t:'i',id:'mouse-image',x:120,y:300,w:120,h:80,blob:'mouse-image-blob'}
    );s.put(p)};
    t.objectStore('blobs').put(blob,'mouse-image-blob');
    await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)});d.close();
  })()`);
  const mouseOriginal = await evaluate("readRecord('pages','page-54').then(p=>p.els)");
  await click('[data-notebook="note-54"] .cover');
  await until("!!document.querySelector('.obj.tex')&&!!document.querySelector('.obj.txt')");
  const pagePoint = (x,y) => evaluate(`(()=>{const r=document.querySelector('.page').getBoundingClientRect(),z=Number(document.querySelector('.pages').style.getPropertyValue('--z'));return {x:r.x+${x}*z,y:r.y+${y}*z}})()`);
  const mouseGesture = async (from,to=from,count=1) => {
    assert.equal(await evaluate(`${JSON.stringify([from,to])}.every(p=>!!document.elementFromPoint(p.x,p.y)?.closest('.viewport'))`),true,'Mouse test gestures must land inside the editor viewport');
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...from});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',clickCount:count});
    if(to!==from)await send('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',clickCount:count});
  };
  const saveMousePage = async () => {
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    await until("readRecord('meta','history:note-54').then(Boolean)");
    // Read after the transaction queued by pagehide, using the same stores.
    return evaluate("readRecord('pages','page-54').then(p=>p.els)");
  };
  for (const key of ['p','h','e','s']) {
    await toolKey(key);
    const start=await pagePoint(400,360);
    await mouseGesture(start,{x:start.x+35,y:start.y+35});
  }
  assert.deepEqual(await saveMousePage(),mouseOriginal,'Mouse drags must never draw, highlight, erase or create shapes');
  await toolKey('p');
  const formulaStart=await formulaPoint();
  await mouseGesture(formulaStart);
  assert.equal(await evaluate("document.querySelectorAll('.selbox').length"),1);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Pen (P)\"]').getAttribute('aria-pressed')"),'true','Mouse selection must preserve the pen tool');
  assert.equal(await evaluate("!!document.querySelector('.tex-panel')"),false,'A single click selects rather than opening the formula editor');
  assert.equal(await cursor(),'default','The mouse uses an arrow, not a drawing cursor');
  await mouseGesture(formulaStart,{x:formulaStart.x+70,y:formulaStart.y+35});
  let mouseEls=await saveMousePage();
  assert(mouseEls.find(e=>e.id==='mouse-formula').x>120,'The selected formula can be dragged immediately');
  const imageStart=await pagePoint(180,340);
  await mouseGesture(imageStart,{x:imageStart.x+60,y:imageStart.y+30});
  mouseEls=await saveMousePage();
  assert(mouseEls.find(e=>e.id==='mouse-image').x>120,'An unselected image is selected and moved in one mouse drag');
  assert.equal(mouseEls.find(e=>e.id==='mouse-image').blob,'mouse-image-blob');
  assert.deepEqual(mouseEls.filter(e=>e.t==='s'),mouseOriginal.filter(e=>e.t==='s'),'Selecting and moving objects must not add or erase handwriting');
  await mouseGesture(await formulaPoint(),undefined,2);
  await until("document.querySelector('.tex-panel textarea')?.value==='x^2'");
  await click('.tex-head [aria-label="Cancel"]');
  await mouseGesture(await pagePoint(170,210));
  assert.equal(await evaluate("!!document.querySelector('.obj.txt.editing')"),false);
  await click('[aria-label="Edit selected object"]');
  await until("!!document.querySelector('.obj.txt.editing')");
  await evaluate("document.querySelector('.obj.txt.editing').textContent='Corrected text'");
  await mouseGesture(await pagePoint(400,360));
  mouseEls=await saveMousePage();
  assert.equal(mouseEls.find(e=>e.id==='mouse-text').text,'Corrected text');
  assert.equal(await evaluate("document.querySelectorAll('.selbox').length"),0,'Clicking blank paper clears the selection');
  const penStart=await pagePoint(400,360);
  await penGesture(penStart,{x:penStart.x+40,y:penStart.y+40});
  mouseEls=await saveMousePage();
  assert.equal(mouseEls.filter(e=>e.t==='s').length,2,'The stylus still draws immediately after mouse selection without reselecting the pen tool');
  await shortcut('z',{ctrlKey:true});
  assert.equal((await saveMousePage()).filter(e=>e.t==='s').length,1,'The new pen stroke remains undoable');
  await mouseGesture(await formulaPoint());
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Edit selected object\"]')"),true);
  await click('.toolbar [aria-label="Add blank page"]');
  await evaluate("[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='Blank page after').click()");
  await until("document.querySelectorAll('.page').length===2");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Edit selected object\"]')"),false,'Rebuilding pages clears mouse selection controls');
  assert.equal(await evaluate("!!document.querySelector('.optbar [aria-label=\"Thickness\"]')"),true,'The pen controls return after mouse selection is cleared');
  console.log('PASS: mouse never draws or erases; click selects formulas, text and pictures, drag moves them, double-click/Edit opens text, and the pen remains ready to write.');

  assert.deepEqual(exceptions, [], 'No uncaught exceptions while restoring positions');
  console.log('PASS: invalid saved positions fall back safely without blocking the PDF.');
} finally {
  ws?.close(); browser.kill('SIGTERM');
  await new Promise((resolve) => server.close(resolve));
  await delay(300); await rm(temp, { recursive: true, force: true });
}
