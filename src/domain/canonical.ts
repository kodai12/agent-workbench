import { createHash } from 'node:crypto';
import type { Digest } from '../../contracts/ports.js';
export function canonical(value: unknown): string {
  const active = new Set<object>();
  function encode(v: unknown): string {
    if(v === null) return 'null';
    if(typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if(typeof v === 'number') {
      if(!Number.isSafeInteger(v)) throw new Error('NON_CANONICAL_NUMBER');
      return JSON.stringify(v);
    }
    if(typeof v !== 'object' || active.has(v)) throw new Error('NON_CANONICAL_VALUE');
    active.add(v);
    try {
      if(Array.isArray(v)) {
        if(Object.keys(v).length !== v.length) throw new Error('NON_CANONICAL_VALUE');
        return '[' + v.map(encode).join(',') + ']';
      }
      if(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('NON_CANONICAL_VALUE');
      const entries = Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
      if(entries.some(([key]) => !/^[\x20-\x7e]+$/.test(key))) throw new Error('NON_ASCII_OBJECT_KEY');
      return '{' + entries.map(([k,x]) => JSON.stringify(k)+':'+encode(x)).join(',') + '}';
    } finally {active.delete(v);}
  }
  return encode(value);
}
export function digest(value:unknown):Digest {return `sha256:${createHash('sha256').update(canonical(value),'utf8').digest('hex')}`;}
export function bytesDigest(bytes:Uint8Array|string):Digest {return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;}
