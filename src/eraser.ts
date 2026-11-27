// Gesture-local geometry and dirty-region rendering. Never touches pointer capture or tool state.
import type { BBox, El, Shape, Stroke } from './types';
import { drawInk, elBBox, eraseFromStroke, hitEl, shapeToStroke } from './render';
type Ink = Stroke | Shape;
const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function bounds(e: Ink): BBox {
  const b = elBBox(e);
  // Highlighters have constant width. Their storage bounds include a full width
  // of padding; repaint only the actual half-width plus device-pixel antialiasing below.
  if (e.t === 's' && e.k === 'hl') { const d=e.s/2; return [b[0]+d,b[1]+d,b[2]-d,b[3]-d]; }
  // Arrowheads protrude beyond the line's nominal bounding box.
  if (e.t === 'h' && e.k === 'arrow') { const p = Math.max(8, e.s * 4); return [b[0]-p,b[1]-p,b[2]+p,b[3]+p]; }
  return b;
}
function union(a: BBox | null, b: BBox): BBox { return a ? [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])] : [...b]; }

/** Bounded uniform grid: very large elements live once in a separate set. */
class InkIndex {
  private cells = new Map<string, Set<Ink>>();
  private entries = new Map<Ink, { bb: BBox; cells: string[] }>();
  private large = new Set<Ink>();
  private keys(b: BBox) {
    const x0=Math.floor(b[0]/64),x1=Math.floor(b[2]/64),y0=Math.floor(b[1]/64),y1=Math.floor(b[3]/64);
    if ((x1-x0+1)*(y1-y0+1)>256) return [];
    const out: string[]=[];for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)out.push(x+','+y);return out;
  }
  add(e: Ink) {
    const bb=bounds(e),cells=this.keys(bb);this.entries.set(e,{bb,cells});
    if(!cells.length)this.large.add(e);
    for(const key of cells){let set=this.cells.get(key);if(!set)this.cells.set(key,set=new Set());set.add(e);}
  }
  remove(e: Ink) {
    const entry=this.entries.get(e);if(!entry)return;
    for(const key of entry.cells){const set=this.cells.get(key)!;set.delete(e);if(!set.size)this.cells.delete(key);}
    this.large.delete(e);this.entries.delete(e);
  }
  query(b: BBox) {
    const keys=this.keys(b),found=new Set<Ink>();
    if(!keys.length){for(const [e,entry]of this.entries)if(overlaps(b,entry.bb))found.add(e);return found;}
    for(const e of this.large)if(overlaps(b,this.entries.get(e)!.bb))found.add(e);
    for(const key of keys)for(const e of this.cells.get(key)??[])if(overlaps(b,this.entries.get(e)!.bb))found.add(e);
    return found;
  }
}

export class EraserSession {
  readonly original: El[];
  private index=new InkIndex();
  private positions=new Map<El,number>();
  private roots=new Map<Ink,Ink>();
  private replacements=new Map<Ink,Ink[]>();
  private shapes=new WeakMap<Shape,Stroke>();
  private dirty: BBox|null=null;
  private touched: BBox|null=null;
  constructor(elements: El[]) {
    this.original=elements.slice();
    elements.forEach((e,i)=>{this.positions.set(e,i);if(e.t==='s'||e.t==='h')this.index.add(e);});
  }
  get changed(){return this.replacements.size>0;}
  erase(x:number,y:number,r:number,partial:boolean) {
    let changed=false;
    for(const el of this.index.query([x-r,y-r,x+r,y+r])) {
      let pieces: Ink[]=[];
      if(partial){
        let stroke=el.t==='s'?el:this.shapes.get(el);
        if(!stroke){stroke=shapeToStroke(el as Shape);this.shapes.set(el as Shape,stroke);}
        const cut=eraseFromStroke(stroke,x,y,r);if(!cut)continue;pieces=cut;
      } else if(!hitEl(el,x,y,r))continue;
      const root=this.roots.get(el)??el;
      const list=this.replacements.get(root)??[root],i=list.indexOf(el);
      if(i<0)continue;
      list.splice(i,1,...pieces);this.replacements.set(root,list);
      this.index.remove(el);this.roots.delete(el);
      for(const p of pieces){this.roots.set(p,root);this.index.add(p);}
      this.dirty=union(this.dirty,bounds(el));this.touched=union(this.touched,bounds(el));
      changed=true;
    }
    return changed;
  }
  /** Materialise once per frame/commit, rather than splicing the full page for every eraser sample. */
  elements(): El[] {
    return this.original.flatMap(e=>(e.t==='s'||e.t==='h')&&this.replacements.has(e)?this.replacements.get(e)!:[e]);
  }
  operation() {
    const removed:[number,El][]=[],added:[number,El][]=[];
    let index=0;
    for(const e of this.original){
      const pieces=(e.t==='s'||e.t==='h')?this.replacements.get(e):undefined;
      if(pieces){removed.push([this.positions.get(e)!,e]);for(const p of pieces)added.push([index++,p]);}
      else index++;
    }
    return {removed,added};
  }
  /** Exact repaint, including translucent overlaps, clipped to dirty device pixels. Pictures stay untouched. */
  paint(canvas:HTMLCanvasElement,scale:number) {
    const b=this.dirty;if(!b||!scale)return;this.dirty=null;
    const x=Math.max(0,Math.floor(b[0]*scale)-2),y=Math.max(0,Math.floor(b[1]*scale)-2);
    const x1=Math.min(canvas.width,Math.ceil(b[2]*scale)+2),y1=Math.min(canvas.height,Math.ceil(b[3]*scale)+2);
    if(x1<=x||y1<=y)return;
    const region:BBox=[x/scale,y/scale,x1/scale,y1/scale];
    const groups=new Map<Ink,Set<Ink>>();
    for(const e of this.index.query([region[0]-2/scale,region[1]-2/scale,region[2]+2/scale,region[3]+2/scale])){const root=this.roots.get(e)??e;let set=groups.get(root);if(!set)groups.set(root,set=new Set());set.add(e);}
    const visible:Ink[]=[];
    for(const root of [...groups.keys()].sort((a,b)=>this.positions.get(a)!-this.positions.get(b)!)) {
      const set=groups.get(root)!;for(const e of this.replacements.get(root)??[root])if(set.has(e))visible.push(e);
    }
    const c=canvas.getContext('2d')!;c.save();c.setTransform(1,0,0,1,0,0);
    c.beginPath();c.rect(x,y,x1-x,y1-y);c.clip();c.clearRect(x,y,x1-x,y1-y);
    c.setTransform(scale,0,0,scale,0,0);drawInk(c,visible);c.restore();
  }
  restore(canvas:HTMLCanvasElement,scale:number) {
    this.index=new InkIndex();this.roots.clear();this.replacements.clear();
    for(const e of this.original)if(e.t==='s'||e.t==='h')this.index.add(e);
    this.dirty=this.touched;this.paint(canvas,scale);
  }
}
