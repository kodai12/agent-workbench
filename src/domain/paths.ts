import {isAbsolute} from 'node:path';
import type {Result} from '../../contracts/ports.js';
import {fail,ok,unwrap} from './errors.js';
export function validateRelativePath(path:string):Result<void> {
 if(!path||isAbsolute(path)||/[\\\0\r\n]/.test(path)||path.split('/').some(s=>!s||s==='.'||s==='..'))return fail('PATH_OUTSIDE_SCOPE','安全な相対パスではありません');
 return ok(undefined);
}
export function matchPattern(path:string,pattern:string):boolean {
 if(/[?\[\]{}()!\\\0\r\n]/.test(pattern))unwrap(fail('INVALID_ARGUMENT','未対応globです'));
 unwrap(validateRelativePath(pattern));const p=path.split('/');const s=pattern.split('/');const memo=new Map<string,boolean>();
 function match(i:number,j:number):boolean{const key=i+':'+j;const cached=memo.get(key);if(cached!==undefined)return cached;let value:boolean;if(j===s.length)value=i===p.length;else if(s[j]==='**')value=match(i,j+1)||(i<p.length&&match(i+1,j));else {const expression='^'+s[j]!.split('*').map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$';value=i<p.length&&new RegExp(expression).test(p[i]!)&&match(i+1,j+1);}memo.set(key,value);return value;}
 return match(0,0);
}
