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
  const chooseView = (value) => evaluate(`document.querySelector('[aria-label="Library view"] [data-view=${JSON.stringify(value)}]').click()`);
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
    const nativeMatchMedia=window.matchMedia.bind(window);
    window.matchMedia=(query)=>{
      const result=nativeMatchMedia(query);
      if(query.startsWith('(resolution:')) window.resolutionQuery=result;
      return result;
    };
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
  await until(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='To LaTeX')`);
  const storedInk = await evaluate("readRecord('pages','page-0').then(p=>p.els)");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='To LaTeX').click()");
  await until("!!document.querySelector('[aria-label=\"Conversion prompt\"]')");
  await click('.modal-actions .primary');
  await until("!!document.querySelector('.page .katex')");
  const request = await evaluate('window.recognitionRequests[0]');
  assert.equal(request.headers.Authorization, 'Bearer test-openai-key');
  assert.equal(request.body.model, 'gpt-5.4');
  assert.equal(request.body.store, false);
  assert.match(request.body.input[0].content[0].image_url, /^data:image\/png;base64,/);
  const shortcut = (key, extra = {}) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,...${JSON.stringify(extra)}}))`);
  const penShortcut = key => shortcut(key, {ctrlKey:true,altKey:true,shiftKey:true});
  const tap = async p => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  };
  const formulaPoint = () => evaluate("(()=>{const r=document.querySelector('.obj.tex').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const titleBeforePen = await evaluate("document.querySelector('[aria-label=\"Notebook title\"]').value");
  await evaluate("document.querySelector('[aria-label=\"Notebook title\"]').focus()");
  await penShortcut('l');
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"),'select','The pen button must work while the notebook title has focus');
  await penShortcut('e');
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"),'eraser');
  await penShortcut('p');
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"),'pen');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Notebook title\"]').value"),titleBeforePen,'Pen shortcuts never type tool letters into the title');
  await evaluate("document.querySelector('[aria-label=\"Notebook title\"]').blur()");
  await shortcut('l');
  await tap(await formulaPoint());
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
  // The LaTeX textarea stops ordinary key events; the hardware chord must reach
  // the editor first, close the source panel and switch to lasso without typing.
  const formulaBeforePen=await evaluate("document.querySelector('.tex-panel textarea').value");
  await penShortcut('l');
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"),'select');
  assert.equal(await evaluate("!!document.querySelector('.tex-panel')"),false);
  assert.equal(formulaBeforePen,'x^2 + y^2 = 1');
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
  const insertBlank = async (index, side, button = '.toolbar [aria-label="Add page or writing space"]', { matchWidth = false, expectedWidth = 595, expectedTpl = 'blank', expectWidthChoice } = {}) => {
    await click(`.thumb[data-i="${index}"]`);
    await until(`document.querySelector('.thumb.current')?.dataset.i==='${index}'`);
    await click(button);
    // Even if the viewport moves with the menu open, insert beside the chosen page.
    await evaluate("document.querySelector('.viewport').scrollTop+=500");
    await delay(50);
    await evaluate(`[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='New page ${side}').click()`);
    const hasWidthChoice=await evaluate("!!document.querySelector('[aria-label=\"Match adjacent page width\"]')");
    if (expectWidthChoice!==undefined) assert.equal(hasWidthChoice,expectWidthChoice);
    if (hasWidthChoice) {
      assert.equal(await evaluate("document.querySelector('[aria-label=\"Match adjacent page width\"]').checked"),true,'Matching the visible page width is offered by default');
      await evaluate(`document.querySelector('[aria-label="Match adjacent page width"]').checked=${matchWidth}`);
      await click('.modal-actions .primary');
    }
    const at = index + (side === 'after' ? 1 : 0);
    await until(`document.querySelectorAll('.page').length===${pageOrder.length + 1}`);
    const nb = await evaluate(`readRecord('notebooks',${JSON.stringify(pdfId)})`);
    const id = nb.pages[at];
    assert(!pageOrder.includes(id), 'Insertion must create a new page, preserving every existing page');
    pageOrder.splice(at, 0, id);
    assert.deepEqual(nb.pages, pageOrder);
    const page = await evaluate(`readRecord('pages',${JSON.stringify(id)})`);
    assert.deepEqual(page.bg, { k: 'paper', tpl: expectedTpl, color: nb.paper });
    assert.deepEqual(page.els, []);
    assert.equal(page.w, expectedWidth, 'Blank pages retain the chosen width');
    assert.equal(page.h, 842);
    assert.equal(await evaluate(`readRecord('dirty',${JSON.stringify('p:' + id)}).then(Boolean)`), true);
    assert.equal(await evaluate(`readRecord('dirty',${JSON.stringify('n:' + pdfId)}).then(Boolean)`), true);
    assert.equal(await evaluate("document.querySelector('.thumb.current').dataset.i"), String(at), 'Jump to the inserted page');
    newPages.push(page);
    return id;
  };
  await insertBlank(0, 'before');
  const middleId = await insertBlank(4, 'after', '.thumb-actions [aria-label="Add page or writing space"]');
  await insertBlank(pageOrder.length - 1, 'after');
  const setMargin = async (value, template) => {
    await click('[aria-label="Writing space beside PDF pages"]');
    await evaluate(`(()=>{const s=document.querySelector('[aria-label="Writing space on the right"]');s.value=${value};s.dispatchEvent(new Event('input'))})()`);
    if (template) await evaluate(`(()=>{const s=document.querySelector('.popover select');s.value=${JSON.stringify(template)};s.dispatchEvent(new Event('change'))})()`);
    await shortcut('Escape');
    await click('.zoom');
  };
  await setMargin(50,'dots');
  const pdfIndex=pageOrder.indexOf(originalPages[0].id);
  await click(`.thumb[data-i="${pdfIndex}"]`);
  await click('.toolbar [aria-label="Add page or writing space"]');
  await evaluate("[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='New page after').click()");
  await until("!!document.querySelector('[aria-label=\"Match adjacent page width\"]')");
  const sizeBeforeWidthDialog=await evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate("(()=>{const d=document.querySelector('.modal');return d.scrollWidth<=d.clientWidth})()"),true,'The width choice must fit a narrow phone screen');
  await send('Emulation.setDeviceMetricsOverride',{...sizeBeforeWidthDialog,mobile:false});
  const widthShot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/opplinotes-page-width.png',Buffer.from(widthShot.data,'base64'));
  await evaluate("[...document.querySelectorAll('.modal-actions button')].find(b=>b.textContent==='Cancel').click()");
  assert.equal(await evaluate("document.querySelectorAll('.page').length"),pageOrder.length,'Cancel must not insert a page');
  assert.deepEqual(await evaluate(`readRecord('notebooks',${JSON.stringify(pdfId)}).then(nb=>nb.pages)`),pageOrder);
  const wideId=await insertBlank(pdfIndex,'after',undefined,{matchWidth:true,expectedWidth:892.5,expectedTpl:'dots',expectWidthChoice:true});
  const wideIndex=pageOrder.indexOf(wideId);
  const widths=await evaluate(`(()=>{const pages=document.querySelectorAll('.page');return [pages[${wideIndex-1}].getBoundingClientRect().width,pages[${wideIndex}].getBoundingClientRect().width]})()`);
  assert(Math.abs(widths[0]-widths[1])<1,'The inserted page must visually line up with the PDF including its writing margin');
  await setMargin(50,'grid');
  await insertBlank(wideIndex,'after',undefined,{expectedWidth:892.5,expectedTpl:'dots',expectWidthChoice:false});
  await insertBlank(pdfIndex,'after','.thumb-actions [aria-label="Add page or writing space"]',{expectedTpl:'grid',expectWidthChoice:true});
  await setMargin(50,'lined');
  await insertBlank(pdfIndex,'before',undefined,{expectedTpl:'lined',expectWidthChoice:true});
  await setMargin(0);
  assert.equal(await evaluate(`readRecord('pages',${JSON.stringify(wideId)}).then(p=>p.w)`),892.5,'A later margin change must not resize blank pages');
  const afterInsert = await evaluate(`(async()=>Promise.all(${JSON.stringify(originalPages.map(p=>p.id))}.map(id=>readRecord('pages',id))))()`);
  assert.deepEqual(afterInsert, originalPages, 'Inserting pages must preserve original PDF references and existing ink exactly');
  assert.equal(await evaluate(`(async()=>{const b=await readRecord('blobs',${JSON.stringify(originalPages[0].bg.blob)});const a=new Uint8Array(await b.arrayBuffer());return btoa(String.fromCharCode(...a))})()`), encoded, 'The original PDF bytes stay untouched');
  console.log('PASS: new pages inherit dots, grid, lines or blank paper and the chosen width; cancellation, repeated additions, existing content and sync markers are preserved.');

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
  for (const page of newPages) assert.deepEqual(exported.getPage(pageOrder.indexOf(page.id)).getSize(), { width: page.w, height: page.h });
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
  await penShortcut('l');
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"),'select');
  assert.equal(await evaluate("!!document.querySelector('.obj.txt.editing')"),false,'The hardware lasso button also finishes a focused inline text editor');
  await penShortcut('p');
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
  await click('.toolbar [aria-label="Add page or writing space"]');
  await evaluate("[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='New page after').click()");
  await until("document.querySelectorAll('.page').length===2");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Edit selected object\"]')"),false,'Rebuilding pages clears mouse selection controls');
  assert.equal(await evaluate("!!document.querySelector('.optbar [aria-label=\"Thickness\"]')"),true,'The pen controls return after mouse selection is cleared');
  console.log('PASS: mouse never draws or erases; click selects formulas, text and pictures, drag moves them, double-click/Edit opens text, and the pen remains ready to write.');

  const inkResolution = () => evaluate(`(()=>{
    const page=document.querySelector('.page'), ink=page.querySelector('canvas.ink'), pics=page.querySelector('canvas.pics');
    const rect=page.getBoundingClientRect(), live=document.querySelector('canvas.live'), lr=live.getBoundingClientRect();
    return {width:ink.width,height:ink.height,cssWidth:rect.width,cssHeight:rect.height,pictureWidth:pics.width,
      dpr:devicePixelRatio,maxPixels:((navigator.deviceMemory??4)>=8?16e6:9e6)*2,
      liveWidth:live.width,liveHeight:live.height,liveCssWidth:lr.width,liveCssHeight:lr.height};
  })()`);
  const assertInkResolution = async (dpr) => {
    const r=await inkResolution();
    const scale=Math.min(dpr*2,Math.sqrt(r.maxPixels/(r.cssWidth*r.cssHeight)));
    assert(Math.abs(r.width-r.cssWidth*scale)<2, 'Committed handwriting must be supersampled within its memory budget: '+JSON.stringify(r));
    assert(Math.abs(r.height-r.cssHeight*scale)<2);
    assert(r.width*r.height<=r.maxPixels*1.002, 'Large pages must respect the ink memory budget');
    const liveScale=Math.max(dpr,Math.min(dpr*2,Math.sqrt(r.maxPixels/(r.liveCssWidth*r.liveCssHeight))));
    assert(Math.abs(r.liveWidth-r.liveCssWidth*liveScale)<2, 'Live pen strokes must receive the same quality improvement');
    assert(Math.abs(r.liveHeight-r.liveCssHeight*liveScale)<2);
    assert(r.width>r.pictureWidth, 'Ink quality must not multiply the resolution of image/PDF layers');
    assert.equal(await evaluate(`(()=>{
      const page=document.querySelector('.page'), canvas=page.querySelector('canvas.ink');
      const scale=canvas.width/Number(page.style.getPropertyValue('--w'));
      return canvas.getContext('2d').getImageData(Math.round(20*scale),Math.round(30*scale),1,1).data[3]>0;
    })()`),true,'Ink must remain painted at its original page coordinates');
    assert.equal(await evaluate(`(async()=>{
      const image=(await readRecord('pages','page-54')).els.find(e=>e.id==='mouse-image');
      const page=document.querySelector('.page'), canvas=page.querySelector('canvas.pics');
      const scale=canvas.width/Number(page.style.getPropertyValue('--w'));
      return canvas.getContext('2d').getImageData(Math.floor((image.x+image.w/2)*scale),Math.floor((image.y+image.h/2)*scale),1,1).data[3]===255;
    })()`),true,'Images must stay aligned when their layer uses a different resolution from ink');
  };
  const inkBeforeResolutionChange=await saveMousePage();
  await evaluate("document.querySelector('.viewport').scrollTo(0,0)");
  await delay(100);
  await until('document.querySelector(".page canvas.ink").width>0');
  await assertInkResolution(1);
  const beforeDprChange=await readView();
  const normalInkWidth=(await inkResolution()).width;
  await send('Emulation.setDeviceMetricsOverride', {width:1440,height:1050,deviceScaleFactor:2,mobile:false});
  // CDP changes devicePixelRatio without emitting the hardware media-query event.
  await evaluate("window.resolutionQuery.dispatchEvent(new Event('change'))");
  await until('devicePixelRatio===2 && document.querySelector(".page canvas.ink").width>'+normalInkWidth);
  await assertInkResolution(2);
  await assertView(beforeDprChange);
  await send('Emulation.setDeviceMetricsOverride', {width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await evaluate("window.resolutionQuery.dispatchEvent(new Event('change'))");
  await until('devicePixelRatio===1 && document.querySelector(".page canvas.ink").width==='+normalInkWidth);
  await assertInkResolution(1);
  for(let i=0;i<12;i++) await shortcut('=',{ctrlKey:true});
  await until('document.querySelector(".zoom").textContent==="600%"');
  await delay(250);
  await assertInkResolution(1);
  assert.deepEqual(await saveMousePage(),inkBeforeResolutionChange,'Resolution, monitor and zoom changes must preserve every original ink sample');
  console.log('PASS: live and saved ink use supersampling, refresh at a new display density without moving the page, and stay within a bounded memory budget at maximum zoom.');

  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  await chooseView('all');
  await click(`[data-notebook="${pdfId}"] .cover`);
  await until("!!document.querySelector('.editor')");
  if(!await evaluate("document.querySelector('.editor').classList.contains('with-thumbs')")) await click('[aria-label="Pages"]');
  const pdfPageId=originalPages[0].id, pdfPageIndex=pageOrder.indexOf(pdfPageId);
  await click(`.thumb[data-i="${pdfPageIndex}"]`);
  await click('.zoom');
  const beforeExtension=await evaluate(`readRecord('pages',${JSON.stringify(pdfPageId)})`);
  const initialHeight=beforeExtension.h+(beforeExtension.ext??0);
  const pdfEdgePoint = async gap => {
    await evaluate(`(()=>{
      const v=document.querySelector('.viewport'),p=document.querySelectorAll('.page')[${pdfPageIndex}];
      v.scrollTop+=p.getBoundingClientRect().bottom-v.getBoundingClientRect().bottom+50;
      v.scrollLeft=0;
    })()`);
    await delay(50);
    return evaluate(`(()=>{
      const r=document.querySelectorAll('.page')[${pdfPageIndex}].getBoundingClientRect();
      const z=Number(document.querySelector('.pages').style.getPropertyValue('--z'));
      return {x:r.left+100*z,y:r.bottom-${gap}*z};
    })()`);
  };
  const pdfHeight = () => evaluate(`Number(document.querySelectorAll('.page')[${pdfPageIndex}].style.getPropertyValue('--h'))`);
  const extensionSaved = async height => {
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    await until(`readRecord('pages',${JSON.stringify(pdfPageId)}).then(p=>p.h+(p.ext??0)===${height})`);
  };
  await pdfEdgePoint(100);
  assert.equal(await evaluate("!!document.querySelector('.modal-back')"),false,'Opening or scrolling near the end must not ask for extra space');
  await toolKey('p');
  let edge=await pdfEdgePoint(100);
  await penGesture(edge,{x:edge.x+20,y:edge.y});
  assert.equal(await evaluate("!!document.querySelector('.modal-back')"),false,'Writing with ample space remaining must not show a prompt');
  edge=await pdfEdgePoint(20);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...edge,button:'left',pointerType:'pen',force:0.5,clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:edge.x+20,y:edge.y,button:'left',buttons:1,pointerType:'pen',force:0.5});
  assert.equal(await evaluate("!!document.querySelector('.modal-back')"),false,'The question must wait until the stroke is finished');
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:edge.x+20,y:edge.y,button:'left',pointerType:'pen',force:0,clickCount:1});
  await until("document.querySelector('.modal h2')?.textContent==='More space below?'");
  assert.equal(await pdfHeight(),initialHeight,'Reaching the edge must never extend the page automatically');
  await extensionSaved(initialHeight);
  await evaluate("[...document.querySelectorAll('.modal-actions button')].find(b=>b.textContent==='Not now').click()");
  edge=await pdfEdgePoint(18);
  await penGesture(edge,{x:edge.x+20,y:edge.y});
  assert.equal(await evaluate("!!document.querySelector('.modal-back')"),false,'Declining must not interrupt every subsequent stroke with the same question');
  assert.equal(await pdfHeight(),initialHeight);
  await click('.toolbar [aria-label="Add page or writing space"]');
  // Keep the explicitly chosen page as the target even if scrolling changes the current page.
  await evaluate("document.querySelector('.viewport').scrollTop+=2000");
  await delay(50);
  await evaluate("[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='Add space below this PDF page').click()");
  const halfPage=Math.round(beforeExtension.h/2);
  assert.equal(await pdfHeight(),initialHeight+halfPage,'Manual extension remains available after declining');
  edge=await pdfEdgePoint(20);
  await penGesture(edge,{x:edge.x+20,y:edge.y});
  await until("document.querySelector('.modal h2')?.textContent==='More space below?'");
  assert.equal(await pdfHeight(),initialHeight+halfPage,'A new edge must also wait for confirmation');
  await click('.modal-actions .primary');
  await until(`Number(document.querySelectorAll('.page')[${pdfPageIndex}].style.getPropertyValue('--h'))===${initialHeight+halfPage*2}`);
  await extensionSaved(initialHeight+halfPage*2);
  const afterExtension=await evaluate(`readRecord('pages',${JSON.stringify(pdfPageId)})`);
  assert.deepEqual(afterExtension.bg,beforeExtension.bg);
  assert.deepEqual(afterExtension.els.slice(0,beforeExtension.els.length),beforeExtension.els,'Extending must preserve existing handwriting');
  assert.equal(afterExtension.els.length,beforeExtension.els.length+4,'Strokes made before declining or accepting must all be saved');
  await click('[aria-label="Settings"]');
  await evaluate("[...document.querySelectorAll('.popover label')].find(l=>l.textContent.includes('Ask for more space below')).querySelector('input').click()");
  await shortcut('Escape');
  edge=await pdfEdgePoint(20);
  await penGesture(edge,{x:edge.x+20,y:edge.y});
  assert.equal(await evaluate("!!document.querySelector('.modal-back')"),false,'The prompt can be disabled in settings');
  assert.equal(await pdfHeight(),initialHeight+halfPage*2,'Disabling questions must never restore automatic growth');
  await extensionSaved(initialHeight+halfPage*2);
  await send('Page.reload');
  await until("!!document.querySelector('.editor')");
  assert.equal(await pdfHeight(),initialHeight+halfPage*2,'Only explicitly approved space survives reloading');
  assert.equal(await evaluate("JSON.parse(localStorage.getItem('margin.tools')).grow"),false);
  assert.equal(await evaluate("!!document.querySelector('.modal-back')"),false);
  console.log('PASS: PDF space is offered only after writing near the edge, never grows without approval, respects declining and disabling, and preserves ink across reload.');

  await evaluate(`(async()=>{
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    const t=d.transaction(['notebooks','pages'],'readwrite');
    const ink=(id,y)=>({t:'s',id,k:'pen',c:'#123456',s:2,p:new Float32Array(Array.from({length:21},(_,i)=>[50+i*20,y,.5]).flat()),bb:[48,y-2,452,y+2]});
    t.objectStore('notebooks').put({id:'lasso-overlap',title:'Lasso overlap demo',folder:'',fav:false,created:1,updated:1,pages:['lasso-overlap-page'],margin:0,marginTpl:'blank',tpl:'blank',paper:'#fff'});
    t.objectStore('pages').put({id:'lasso-overlap-page',nb:'lasso-overlap',w:595,h:842,bg:{k:'paper',tpl:'blank',color:'#fff'},els:[
      ink('partly-enclosed',100),ink('untouched',180),
      {t:'i',id:'locked-picture',x:220,y:95,w:40,h:30,blob:'mouse-image-blob',lock:true}
    ]});
    await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)});d.close();location.hash='#/n/lasso-overlap';
  })()`);
  await until("document.querySelector('[aria-label=\"Notebook title\"]')?.value==='Lasso overlap demo'");
  await until("document.querySelector('.page canvas.ink')?.width>0");
  await toolKey('l');
  const partialLoop=[];
  for(const [x,y] of [[220,90],[260,90],[260,110],[220,110],[220,90]]) partialLoop.push(await pagePoint(x,y));
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...partialLoop[0],button:'left',pointerType:'pen',force:.5,clickCount:1});
  for(const p of partialLoop.slice(1)) await send('Input.dispatchMouseEvent',{type:'mouseMoved',...p,button:'left',buttons:1,pointerType:'pen',force:.5});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...partialLoop.at(-1),button:'left',pointerType:'pen',force:0,clickCount:1});
  await until("!!document.querySelector('.selbox')");
  assert.equal(await evaluate("document.querySelector('.viewport').dataset.tool"),'select');
  assert.equal(await evaluate("(()=>{const z=Number(document.querySelector('.pages').style.getPropertyValue('--z'));return document.querySelector('.selbox').getBoundingClientRect().width/z>390})()"),true,'Enclosing a short middle section selects the entire long stroke');
  const beforePartialMove=await evaluate("readRecord('pages','lasso-overlap-page').then(p=>p.els)");
  const startPartialMove=await pagePoint(240,100);
  await penGesture(startPartialMove,{x:startPartialMove.x+60,y:startPartialMove.y+30});
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  const afterPartialMove=await evaluate("readRecord('pages','lasso-overlap-page').then(p=>p.els)");
  assert(afterPartialMove[0].bb[0]>beforePartialMove[0].bb[0],'The partly enclosed stroke moves as a whole');
  assert.deepEqual(afterPartialMove.slice(1),beforePartialMove.slice(1),'Untouched strokes and locked pictures stay unchanged');
  assert.equal(await evaluate("!!document.querySelector('.selbox')"),true,'Partial lasso selections remain selected after moving');
  await shortcut('z',{ctrlKey:true});
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  assert.deepEqual(await evaluate("readRecord('pages','lasso-overlap-page').then(p=>p.els)"),beforePartialMove,'Moving a partly enclosed stroke remains exactly undoable');
  const lassoToolbar=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:1440,height:130,scale:1.5}});
  await writeFile('/tmp/opplinotes-lasso-toolbar.png',Buffer.from(lassoToolbar.data,'base64'));
  console.log('PASS: a partly enclosed stroke is fully selected and movable, locked pictures and untouched ink are excluded, and moving remains undoable.');

  // Prompted graphs use the same durable, editable and undoable object path as formulas.
  await click('[aria-label="Back to library"]');
  await until("!!document.querySelector('.library')");
  await evaluate(`(async()=>{
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    const t=d.transaction(['notebooks','pages'],'readwrite');
    t.objectStore('notebooks').put({id:'graphs',title:'Graph generation demo',folder:'',fav:false,created:1,updated:1,pages:['graph-page'],margin:0,marginTpl:'blank',tpl:'blank',paper:'#fff'});
    t.objectStore('pages').put({id:'graph-page',nb:'graphs',w:595,h:842,bg:{k:'paper',tpl:'blank',color:'#fff'},els:[{t:'h',id:'graph-ink',k:'line',c:'#123456',s:2,x1:100,y1:100,x2:180,y2:140}]});
    await new Promise(r=>t.oncomplete=r);d.close();location.hash='#/n/graphs';
  })()`);
  await until("document.querySelector('[aria-label=\"Notebook title\"]')?.value==='Graph generation demo'");
  const originalGraphInk=await evaluate("readRecord('pages','graph-page').then(p=>p.els)");
  const graph='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><title>Example graph</title><rect width="400" height="300" fill="#fff"/><path d="M40 20V260H380M40 220Q200 -100 360 220" fill="none" stroke="#2563eb" stroke-width="3"/><circle cx="200" cy="150" r="30" fill="#ff0000"/><text x="200" y="285" text-anchor="middle" font-size="16">x</text></svg>';
  await evaluate(`(()=>{
    window.graphRequests=[];window.graphReply=${JSON.stringify(graph)};
    const original=window.fetch;window.fetch=async(url,init)=>{
      if(String(url).startsWith('https://api.openai.com/')){
        graphRequests.push(JSON.parse(init.body));
        return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:graphReply}]}]});
      }
      return original(url,init);
    };
  })()`);
  await toolKey('l');
  await mouseGesture(await pagePoint(140,120));
  const openConversion=async()=>{
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='To LaTeX').click()");
    await until("!!document.querySelector('[aria-label=\"Conversion prompt\"]')");
  };
  await openConversion();
  await evaluate("[...document.querySelectorAll('.modal-actions button')].find(b=>b.textContent==='Cancel').click()");
  assert.equal(await evaluate('graphRequests.length'),0,'Cancel does not send handwriting');
  await evaluate(`window.graphReply=${JSON.stringify(graph.replace('</svg>','<script>alert(1)</script></svg>'))}`);
  await openConversion();
  await click('.modal-actions .primary');
  await until("document.querySelector('.toast')?.textContent.includes('Recognition failed')");
  assert.equal(await evaluate("!!document.querySelector('.math-graphic')"),false);
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  assert.deepEqual(await evaluate("readRecord('pages','graph-page').then(p=>p.els)"),originalGraphInk,'Invalid AI output never replaces the original ink');
  await evaluate(`window.graphReply=${JSON.stringify(graph)};window.graphRequests=[]`);
  await openConversion();
  await evaluate(`document.querySelector('[aria-label="Conversion prompt"]').value='Plot this function and label both axes'`);
  await click('.modal-actions .primary');
  await until("document.querySelector('.math-graphic')?.complete");
  assert.match(await evaluate('graphRequests[0].input[0].content[1].text'),/Plot this function and label both axes/);
  assert.match(await evaluate('graphRequests[0].input[0].content[0].image_url'),/^data:image\/png;base64,/);
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  const generated=await evaluate("readRecord('pages','graph-page').then(p=>p.els[0])");
  assert(generated.src.startsWith('<svg'));
  assert.deepEqual(generated.handwriting.ink,originalGraphInk);
  assert.equal(await evaluate("document.querySelector('.math-graphic').naturalWidth"),400);
  assert.equal(generated.w,384);
  assert.equal(generated.h,288);
  await shortcut('z',{ctrlKey:true});
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  assert.deepEqual(await evaluate("readRecord('pages','graph-page').then(p=>p.els)"),originalGraphInk);
  await shortcut('y',{ctrlKey:true});
  await until("document.querySelector('.math-graphic')?.complete");
  const graphCentre=await pagePoint(generated.x+192,generated.y+144);
  await mouseGesture(graphCentre);
  await click('[aria-label="Edit selected object"]');
  await until("!!document.querySelector('[aria-label=\"SVG source\"]')");
  assert.equal(await evaluate("document.querySelector('.tex-head strong').textContent"),'Edit graphic');
  assert.equal(await evaluate("!!document.querySelector('.snips')"),false);
  // Active markup and external resources must never become part of a saved graphic.
  for(const bad of [
    graph.replace('</svg>','<script>alert(1)</script></svg>'),
    graph.replace('<svg ','<svg onload="alert(1)" '),
    graph.replace('</svg>','<image href="https://example.invalid/private"/></svg>'),
    graph.replace('fill="#ff0000"','fill="url(https://example.invalid/private)"'),
    '<svg viewBox="0 0 0 300"></svg>'
  ]){
    await evaluate(`(()=>{const t=document.querySelector('[aria-label="SVG source"]');t.value=${JSON.stringify(bad)};t.dispatchEvent(new Event('input'))})()`);
    await click('.tex-panel .primary');
    assert.equal(await evaluate("!!document.querySelector('.tex-panel')"),true,'Invalid SVG stays in the editor');
    assert(await evaluate("document.querySelector('.tex-err').textContent"));
  }
  await evaluate(`(()=>{const t=document.querySelector('[aria-label="SVG source"]');t.value=${JSON.stringify(graph.replace('Example graph','Corrected graph'))};t.dispatchEvent(new Event('input'))})()`);
  await click('.tex-panel .primary');
  await until("!document.querySelector('.tex-panel')");
  await shortcut('z',{ctrlKey:true});
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  assert.match(await evaluate("readRecord('pages','graph-page').then(p=>p.els[0].src)"),/Example graph/);
  await shortcut('y',{ctrlKey:true});
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  await send('Page.reload');
  await until("document.querySelector('.math-graphic')?.complete");
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  const savedGraphic=await evaluate("readRecord('pages','graph-page').then(p=>p.els[0])");
  assert.match(savedGraphic.src,/Corrected graph/);
  assert.deepEqual(savedGraphic.handwriting.ink,originalGraphInk);
  // Inspect the actual page raster produced for PDF export, including the SVG pixels.
  await evaluate(`(()=>{
    const original=HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob=function(...args){
      if(this.width===1785&&this.height===2526){
        window.graphPdfPixel=Array.from(this.getContext('2d').getImageData(${Math.round((savedGraphic.x+192)*3)},${Math.round((savedGraphic.y+144)*3)},1,1).data);
      }
      return original.apply(this,args);
    };
    HTMLAnchorElement.prototype.click=function(){if(this.download&&this.href.startsWith('blob:'))window.graphDownload={name:this.download,body:fetch(this.href).then(r=>r.blob()).then(async b=>b.type==='image/svg+xml'?await b.text():btoa(String.fromCharCode(...new Uint8Array(await b.arrayBuffer()))))}};
  })()`);
  await click('[aria-label="Export"]');
  await evaluate("[...document.querySelectorAll('.menu button')].find(b=>b.textContent==='Export as PDF').click()");
  await until('!!window.graphPdfPixel');
  const pixel=await evaluate('graphPdfPixel');
  assert(pixel[0]>240&&pixel[1]<10&&pixel[2]<10&&pixel[3]>240,'The graph is present in the exported PDF raster');
  await until('!!window.graphDownload');
  assert.equal((await PDFDocument.load(Buffer.from(await evaluate('graphDownload.body'),'base64'))).getPageCount(),1);
  await mouseGesture(await pagePoint(savedGraphic.x+192,savedGraphic.y+144));
  await click('[aria-label="Edit selected object"]');
  await evaluate("[...document.querySelectorAll('.tex-panel button')].find(b=>b.textContent==='Save SVG').click()");
  assert.equal(await evaluate('graphDownload.name'),'opplinotes-graphic.svg');
  assert.match(await evaluate('graphDownload.body'),/Corrected graph/);
  const graphicShot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/opplinotes-graphic.png',Buffer.from(graphicShot.data,'base64'));
  await evaluate("[...document.querySelectorAll('.tex-panel button')].find(b=>b.textContent==='Restore handwriting').click()");
  await evaluate("window.dispatchEvent(new Event('pagehide'))");
  const graphRestored=await evaluate("readRecord('pages','graph-page').then(p=>p.els)");
  assert.deepEqual(graphRestored.map(e=>({...e,id:'graph-ink'})),originalGraphInk);
  console.log('PASS: optional prompts, cancel, SVG graphs, source editing/download, active-content rejection, undo/redo, offline reload, PDF pixels and original handwriting restoration.');

  assert.deepEqual(exceptions, [], 'No uncaught exceptions while restoring positions');
  console.log('PASS: invalid saved positions fall back safely without blocking the PDF.');
} finally {
  ws?.close(); browser.kill('SIGTERM');
  await new Promise((resolve) => server.close(resolve));
  await delay(300); await rm(temp, { recursive: true, force: true });
}
