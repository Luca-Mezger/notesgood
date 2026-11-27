import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const { outputFiles } = await build({ entryPoints: ['src/activity.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { ActivityClock, ACTIVITY_KINDS, COUNTERS, activeMs, dayKey } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const context = { notebook: 'n', title: 'Math', folder: 'ETH / Math', page: 'p1', pageNumber: 1 };
const start = +new Date(2026, 10, 27, 12);
const total = rows => Object.fromEntries(ACTIVITY_KINDS.map(k => [k, rows.reduce((a,b) => a+b.ms[k],0)]));
const counts = rows => Object.fromEntries(COUNTERS.map(k => [k, rows.reduce((a,b) => a+b.counts[k],0)]));
function ticks(c, from, to) { for(let t=from+1000;t<=to;t+=1000)c.tick(t); c.tick(to); }

test('pen contact, highlights and navigation are exclusive; tool choice alone is not writing',()=>{
 const c=new ActivityClock('s',context,start);
 c.activity('writing',start,2000); c.tick(start+1000); c.release(start+1250); c.count('strokes',start+1250);
 c.activity('highlighting',start+2000,2000); c.release(start+2500); c.count('highlights',start+2500);
 c.activity('navigation',start+3000,400);c.tick(start+4000);
 const r=c.drain(start+4000),t=total(r);
 assert.equal(t.writing,1250);assert.equal(t.highlighting,500);assert.equal(t.navigation,400);assert.equal(t.reading,1850);
 assert.equal(Object.values(t).reduce((a,b)=>a+b),4000);assert.equal(counts(r).strokes,1);assert.equal(counts(r).highlights,1);
});

test('no input becomes idle at the exact threshold, without retroactively inflating active time',()=>{
 const c=new ActivityClock('s',context,start,15000);ticks(c,start,start+60000);
 const t=total(c.drain(start+60000));assert.equal(t.reading,15000);assert.equal(t.idle,45000);
});

test('window blur plus hidden is one switch; no input is recorded while away',()=>{
 const c=new ActivityClock('s',context,start);c.setForeground(false,start+1000);c.setForeground(false,start+1000);
 c.activity('writing',start+2000);c.count('strokes',start+2000);ticks(c,start+1000,start+9000);
 c.setForeground(true,start+9000);c.setForeground(true,start+9000);c.activity('editing',start+10000);c.release(start+11000);
 const r=c.drain(start+11000),t=total(r),n=counts(r);
 assert.equal(t.away,8000);assert.equal(t.writing,0);assert.equal(n.strokes,0);assert.equal(n.awaySwitches,1);assert.equal(n.returns,1);assert.equal(n.focusStarts,2);
});

test('page switches charge preceding time to the old page and do not duplicate same-page visits',()=>{
 const c=new ActivityClock('s',context,start);c.activity('writing',start,2000);c.release(start+1000);
 c.setContext({...context,page:'p2',pageNumber:2},start+2000);c.setContext({...context,page:'p2',pageNumber:2},start+2500);
 c.activity('editing',start+2500);const rows=c.drain(start+3000);
 assert.equal(rows.find(r=>r.page==='p1').ms.writing,1000);assert.equal(rows.find(r=>r.page==='p2').ms.writing,0);
 assert.equal(counts(rows).pageViews,2);assert.equal(counts(rows).pageSwitches,1);
});

test('minute and midnight boundaries preserve exact local dates and total duration',()=>{
 const t=+new Date(2026,10,27,23,59,58),c=new ActivityClock('s',context,t,30000);c.activity('writing',t,2000);c.release(t+1000);ticks(c,t+1000,t+6000);
 const rows=c.drain(t+6000);assert.equal(rows.length,2);assert.equal(rows[0].day,dayKey(t));assert.equal(rows[1].day,dayKey(t+6000));
 assert.equal(rows.reduce((a,b)=>a+activeMs(b),0),6000);
});

test('sleep or missing pointer-up cannot accumulate writing or active time indefinitely',()=>{
 const c=new ActivityClock('s',context,start);c.activity('writing',start,2000);ticks(c,start,start+5000);c.tick(start+3600000);
 const t=total(c.drain(start+3600000));assert.equal(t.writing,2000);assert.equal(t.reading,3000);assert.equal(t.idle,3595000);
});

test('checkpoints are cumulative, finished minutes leave memory, and closing freezes time',()=>{
 const c=new ActivityClock('s',context,start);c.count('strokes',start);const a=c.drain(start+1000);const b=c.drain(start+2000);
 assert.equal(a[0].id,b[0].id);assert.equal(a[0].ms.reading,1000);assert.equal(b[0].ms.reading,2000);assert.equal(b[0].counts.strokes,1);
 ticks(c,start+2000,start+61000);c.drain(start+61000);const d=c.drain(start+62000);assert.equal(d.length,1);assert.equal(d[0].minute,start+60000);
 c.stop(start+63000);const r=c.drain(start+100000);assert.equal(r[0].end,start+63000);c.activity('writing',start+110000);assert.deepEqual(c.drain(start+120000),[]);
});

test('opening an unfocused tab does not invent a switch away or active time',()=>{
 const c=new ActivityClock('s',context,start,30000,false);ticks(c,start,start+5000);const r=c.drain(start+5000);assert.equal(total(r).away,5000);assert.equal(activeMs(r[0]),0);assert.equal(counts(r).awaySwitches,0);assert.equal(counts(r).opens,1);
});
