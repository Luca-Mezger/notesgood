import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/render.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { elInPoly } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const box = (x0, y0, x1, y1) => [x0,y0,x1,y0,x1,y1,x0,y1];
const stroke = (points, s=2, k='pen') => {
  const xs=points.map(p=>p[0]), ys=points.map(p=>p[1]);
  return {t:'s',id:'test-ink',k,c:'#000',s,p:new Float32Array(points.flatMap(([x,y,p=.5])=>[x,y,p])),bb:[Math.min(...xs)-s,Math.min(...ys)-s,Math.max(...xs)+s,Math.max(...ys)+s]};
};

test('enclosing a small part selects the whole stroke without changing its samples',()=>{
  const ink=stroke(Array.from({length:21},(_,i)=>[i*5,10]));
  const original=Array.from(ink.p);
  assert.equal(elInPoly(ink,box(45,5,55,15)),true);
  assert.deepEqual(Array.from(ink.p),original);
  assert.equal(elInPoly(ink,box(-10,0,110,20)),true);
});

test('a crossing between sparse samples is selected even when neither endpoint is enclosed',()=>{
  const ink=stroke([[0,10],[100,10]]);
  assert.equal(elInPoly(ink,box(40,0,60,20)),true);
  assert.equal(elInPoly(ink,[40,0,60,0,60,20]),true,'The closing edge participates in selection');
  assert.equal(elInPoly(ink,[50,0,50,20]),true,'An open lasso can cross a stroke');
});

test('bounding-box overlap and empty shape interiors do not select untouched ink',()=>{
  assert.equal(elInPoly(stroke([[0,0],[100,100]]),box(0,70,20,90)),false);
  const rect={t:'h',id:'rect',k:'rect',c:'#000',s:2,x1:0,y1:0,x2:100,y2:100};
  assert.equal(elInPoly(rect,box(40,40,60,60)),false);
  assert.equal(elInPoly(rect,box(90,40,110,60)),true,'Part of a shape outline is enough');
  assert.equal(elInPoly(stroke([[0,0],[100,0]]),box(150,-10,170,10)),false);
});

test('touching actual stroke width selects dots, highlights and pressure-sensitive ink',()=>{
  assert.equal(elInPoly(stroke([[0,0]],4),box(1,-1,3,1)),true);
  assert.equal(elInPoly(stroke([[0,0],[100,0]],6),box(40,2,60,5)),true);
  assert.equal(elInPoly(stroke([[0,0],[100,0]],6),box(40,4,60,6)),false);
  assert.equal(elInPoly(stroke([[0,0],[100,0]],10,'hl'),box(40,4,60,6)),true);
  assert.equal(elInPoly(stroke([[0,0,0],[100,0,0]],10),box(40,3,60,5)),false);
  assert.equal(elInPoly(stroke([[0,0,1],[100,0,1]],10),box(40,3,60,5)),true);
});

test('text, formulas and pictures retain centre-based lasso selection',()=>{
  for(const t of ['t','x','i']) {
    const el={t,id:'object',x:0,y:0,w:100,h:100,fs:20,c:'#000',text:'demo',src:'x',blob:'demo'};
    assert.equal(elInPoly(el,box(90,40,110,60)),false);
    assert.equal(elInPoly(el,box(40,40,60,60)),true);
  }
  assert.equal(elInPoly(stroke([[10,10]]),[]),false);
});
