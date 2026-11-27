// Disposable browser/storage only. Never connects to the user's notes or sync server.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), 'opplinotes-eraser-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const helper=(await build({stdin:{contents:"export {drawInk} from './src/render';",resolveDir:process.cwd()},bundle:true,format:'esm',write:false})).outputFiles[0].text;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if(path==='/eraser-test.mjs'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(helper);return}
    const file = join(process.env.OPPLINOTES_TEST_DIST || join(process.cwd(), 'dist'), path === '/' ? 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
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
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('goodnotes.auto','off')"});
  await send('Page.navigate',{url:base});
  await until("!!document.querySelector('.library')");
  await evaluate(`(async()=>{
    window.reference=await import('/eraser-test.mjs');
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    window.readPage=id=>new Promise(r=>{const q=d.transaction('pages').objectStore('pages').get(id);q.onsuccess=()=>r(q.result)});
    window.inkOriginal=[];
    for(let i=0;i<2200;i++){
      const x=10+(i%40)*14,y=50+Math.floor(i/40)*12,p=new Float32Array(256*3);
      for(let j=0;j<256;j++){p[j*3]=x+j*8/256;p[j*3+1]=y+Math.sin(j*.12)*.5;p[j*3+2]=.5;}
      inkOriginal.push({t:'s',id:'ink-'+i,k:'pen',c:'#123456',s:.6,p,bb:[x-.6,y-1.1,x+8.6,y+1.1]});
    }
    inkOriginal.push({t:'s',id:'highlight',k:'hl',c:'#ffd600',s:14,p:new Float32Array([20,290,.5,560,290,.5]),bb:[6,276,574,304]},
     {t:'h',id:'arrow',k:'arrow',c:'#f00',s:3,x1:50,y1:355,x2:300,y2:355},
     {t:'h',id:'ellipse',k:'ellipse',c:'#080',s:2,x1:350,y1:330,x2:470,y2:380},
     {t:'i',id:'picture',x:20,y:250,w:540,h:140,blob:'picture',lock:true},
     {t:'x',id:'formula',x:70,y:420,fs:18,c:'#000',src:'x^2'});
    const c=document.createElement('canvas');c.width=c.height=2;c.getContext('2d').fillStyle='#e3ac67';c.getContext('2d').fillRect(0,0,2,2);const blob=await new Promise(r=>c.toBlob(r));
    const t=d.transaction(['notebooks','pages','blobs'],'readwrite');t.objectStore('blobs').put(blob,'picture');
    for(const mode of ['stroke','partial']){
      t.objectStore('notebooks').put({id:mode,title:'Eraser '+mode,folder:'',fav:false,created:1,updated:1,pages:[mode+'-1'],margin:0,marginTpl:'blank',tpl:'blank',paper:'#fff'});
      t.objectStore('pages').put({id:mode+'-1',nb:mode,w:595,h:842,bg:{k:'paper',tpl:'blank',color:'#fff'},els:structuredClone(inkOriginal)});
    }
    await new Promise(r=>t.oncomplete=r);
    window.pixelDifference=async id=>{
      const page=await readPage(id),ink=document.querySelector('.page canvas.ink'),s=Number(document.querySelector('.pages').style.getPropertyValue('--z'))*devicePixelRatio*2,c=document.createElement('canvas');c.width=ink.width;c.height=ink.height;
      const ctx=c.getContext('2d');ctx.setTransform(s,0,0,s,0,0);reference.drawInk(ctx,page.els);
      const a=ink.getContext('2d').getImageData(0,0,c.width,c.height).data,b=ctx.getImageData(0,0,c.width,c.height).data;
      let count=0,max=0,x0=Infinity,y0=Infinity,x1=0,y1=0,samples=[];for(let i=0;i<a.length;i++)if(a[i]!==b[i]){count++;max=Math.max(max,Math.abs(a[i]-b[i]));const px=(i>>2)%c.width,py=Math.floor((i>>2)/c.width);x0=Math.min(x0,px);x1=Math.max(x1,px);y0=Math.min(y0,py);y1=Math.max(y1,py);if(samples.length<6&&i%4===3)samples.push({x:px/s,y:py/s,actual:[...a.slice(i-3,i+1)],expected:[...b.slice(i-3,i+1)]});}window.eraserDiffInfo={bounds:[x0/s,y0/s,x1/s,y1/s],samples,scale:s};return {count,max};
    };
  })()`);
  const key=(key,extra={})=>evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,...${JSON.stringify(extra)}}))`);
  const point=(x,y)=>evaluate(`(()=>{const r=document.querySelector('.page').getBoundingClientRect(),z=Number(document.querySelector('.pages').style.getPropertyValue('--z'));return {x:r.left+${x}*z,y:r.top+${y}*z,z}})()`);
  const pointer=(type,p,extra={})=>send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',pointerType:'pen',force:type==='mouseReleased'?0:.5,...extra});
  const flush=async()=>{await evaluate("window.dispatchEvent(new Event('pagehide'))");await delay(100)};
  for(const mode of ['stroke','partial']){
    await evaluate(`localStorage.setItem('margin.tools',JSON.stringify({tool:'eraser',eraser:{s:14,mode:${JSON.stringify(mode)}}}));location.hash='#/n/${mode}'`);
    await until("!!document.querySelector('.editor') && document.querySelector('.page canvas.ink')?.width>0");
    await until(`(()=>{const c=document.querySelector('.page canvas.pics');if(!c?.width)return false;const s=c.width/595,p=c.getContext('2d').getImageData(Math.round(200*s),Math.round(310*s),1,1).data;return p[0]===227&&p[1]===172&&p[2]===103})()`);
    await delay(300);
    await evaluate(`(()=>{window.pagePictureDraws=0;window.fullClears=0;const originalClear=CanvasRenderingContext2D.prototype.clearRect,originalDraw=CanvasRenderingContext2D.prototype.drawImage;window.restoreCanvas=()=>{CanvasRenderingContext2D.prototype.clearRect=originalClear;CanvasRenderingContext2D.prototype.drawImage=originalDraw};CanvasRenderingContext2D.prototype.clearRect=function(x,y,w,h){if(this.canvas.matches('.page canvas.pics'))pagePictureDraws++;if(this.canvas.matches('.page canvas.ink')&&w===this.canvas.width&&h===this.canvas.height)fullClears++;return originalClear.call(this,x,y,w,h)};CanvasRenderingContext2D.prototype.drawImage=function(...a){if(this.canvas.matches('.page canvas.pics'))pagePictureDraws++;return originalDraw.apply(this,a)};document.addEventListener('pointerdown',e=>window.testId=e.pointerId,{once:true,capture:true})})()`);
    const start=await point(20,290);await pointer('mousePressed',start,{clickCount:1});
    const timing=await evaluate(`(async()=>{const v=document.querySelector('.viewport'),times=[],frames=[];let last=performance.now();for(let i=1;i<=30;i++){await new Promise(requestAnimationFrame);const t=performance.now();if(i>1)frames.push(t-last);last=t;const begin=performance.now();for(let j=0;j<4;j++)v.dispatchEvent(new PointerEvent('pointermove',{pointerId:testId,pointerType:'pen',buttons:1,pressure:.5,clientX:${start.x}+(i*14+j*3)*${start.z},clientY:${start.y},bubbles:true}));times.push(performance.now()-begin)}await new Promise(requestAnimationFrame);times.sort((a,b)=>a-b);frames.sort((a,b)=>a-b);return {mode:${JSON.stringify(mode)},points:563200,updates:120,p95Ms:times[Math.floor(times.length*.95)],frameP95Ms:frames[Math.floor(frames.length*.95)],frameMedianMs:frames[Math.floor(frames.length*.5)],fullClears,pagePictureDraws}})()`);
    await pointer('mouseReleased',{x:start.x+429*start.z,y:start.y});await flush();
    console.log('ERASER BENCHMARK '+JSON.stringify(timing));
    if(process.env.OPPLINOTES_BENCHMARK_ONLY==='1'){await evaluate("restoreCanvas();location.hash=''");await until("!!document.querySelector('.library')");continue;}
    assert.equal(timing.fullClears,0,'Erasing must not clear/redraw the full ink canvas');
    assert.equal(timing.pagePictureDraws,0,'Erasing must not touch the image canvas');
    assert(timing.frameP95Ms<80,'Erasing must remain responsive on dense pages');
    const difference=await evaluate(`pixelDifference('${mode}-1')`);if(difference.count)console.log('PIXEL DETAILS',JSON.stringify(await evaluate('eraserDiffInfo')));
    assert.deepEqual(difference,{count:0,max:0},'Dirty-region repaint must be pixel-identical to a complete render, including highlighter overlaps');
    assert.equal(await evaluate(`readPage('${mode}-1').then(p=>p.els.some(e=>e.id==='picture')&&p.els.some(e=>e.id==='formula'))`),true);
    await key('z',{ctrlKey:true});await flush();
    assert.equal(await evaluate(`readPage('${mode}-1').then(p=>p.els.length===inkOriginal.length&&p.els.every((e,i)=>e.id===inkOriginal[i].id))`),true,'Undo restores original elements and ordering');
    await key('z',{ctrlKey:true,shiftKey:true});await flush();
    assert.deepEqual(await evaluate(`pixelDifference('${mode}-1')`),{count:0,max:0});
    // Cancel an actual eraser gesture after frames have painted, then compare full pixels and data.
    await key('z',{ctrlKey:true});await flush();
    const cancel=await point(80,355);await pointer('mousePressed',cancel,{clickCount:1});await pointer('mouseMoved',{x:cancel.x+100,y:cancel.y},{buttons:1});await delay(100);
    await evaluate(`document.querySelector('.viewport').dispatchEvent(new PointerEvent('pointercancel',{pointerId:${await evaluate('testId')},pointerType:'pen',bubbles:true}))`);
    await pointer('mouseReleased',{x:cancel.x+100,y:cancel.y});
    await flush();assert.deepEqual(await evaluate(`pixelDifference('${mode}-1')`),{count:0,max:0});
    assert.equal(await evaluate(`readPage('${mode}-1').then(p=>p.els.length===inkOriginal.length)`),true,'Cancellation restores every original without an extra undo step');
    // Mouse erasing stays disabled, and the next pen stroke still writes normally.
    const n=await evaluate(`readPage('${mode}-1').then(p=>p.els.length)`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:cancel.x,y:cancel.y,button:'left',pointerType:'mouse',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:cancel.x,y:cancel.y,button:'left',pointerType:'mouse'});await flush();
    assert.equal(await evaluate(`readPage('${mode}-1').then(p=>p.els.length)`),n);
    await key('p');const write=await point(100,180);await pointer('mousePressed',write,{clickCount:1});await pointer('mouseMoved',{x:write.x+40,y:write.y+10},{buttons:1});await pointer('mouseReleased',{x:write.x+40,y:write.y+10});await flush();
    await until(`readPage('${mode}-1').then(p=>p.els.length===${n+1})`);
    await evaluate("restoreCanvas();location.hash=''");await until("!!document.querySelector('.library')");
  }
  assert.deepEqual(exceptions,[]);
  console.log('PASS: whole and partial erasing stay local and fast; exact pixels, translucent overlap, shapes, images, formula retention, undo/redo, cancellation, no mouse ink and immediate pen writing are preserved.');
} finally {ws?.close();browser.kill('SIGTERM');await new Promise(resolve=>server.close(resolve));await delay(300);await rm(temp,{recursive:true,force:true});}
