import type {Json} from '../../contracts/ports.js';
export function isJson(value:unknown):value is Json {
  const active=new Set<object>();
  function check(v:unknown,depth=0):boolean {
    if(depth>64)return false;
    if(v===null||typeof v==='string'||typeof v==='boolean')return true;
    if(typeof v==='number')return Number.isFinite(v);
    if(typeof v!=='object'||active.has(v))return false;
    active.add(v);
    try {
      if(Array.isArray(v))return Object.keys(v).length===v.length&&v.every(x=>check(x,depth+1));
      if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)return false;
      return Object.values(v).every(x=>check(x,depth+1));
    }finally{active.delete(v);}
  }
  return check(value);
}
