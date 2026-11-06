import {isJson} from '../domain/json.js';
export {isJson} from '../domain/json.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Json, Result } from '../../contracts/ports.js';
import { fail, ok } from '../domain/errors.js';
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export function parseJson(text:string):Result<Json> {
  if(Buffer.byteLength(text,'utf8') > MAX_JSON_BYTES) return fail('FRAME_TOO_LARGE','JSONが8MiBを超えています');
  let i=0;
  const ws=()=>{while(/\s/.test(text[i] ?? '') && i<text.length) i++;};
  function string():string {
    const start=i++;
    while(i<text.length) {
      const c=text[i++];
      if(c==='\\') i++;
      else if(c==='"') {const v:unknown=JSON.parse(text.slice(start,i));if(typeof v==='string') return v;break;}
    }
    throw new Error('INVALID_JSON');
  }
  function value(depth:number):void {
    if(depth>64) throw new Error('JSON_DEPTH_EXCEEDED');
    ws();const c=text[i];
    if(c==='"') {string();return;}
    if(c==='{' || c==='[') {
      i++;ws();const object=c==='{', end=object?'}':']', keys=new Set<string>();
      if(text[i]===end){i++;return;}
      for(;;) {
        ws();if(object) {
          if(text[i]!=='"') throw new Error('INVALID_JSON');
          const key=string();if(keys.has(key)) throw new Error('DUPLICATE_JSON_KEY');
          keys.add(key);if(keys.size>10000) throw new Error('JSON_KEYS_EXCEEDED');
          ws();if(text[i++]!==':') throw new Error('INVALID_JSON');
        }
        value(depth+1);ws();const next=text[i++];if(next===end) return;if(next!==',') throw new Error('INVALID_JSON');
      }
    }
    const start=i;while(i<text.length && !/[\s,\]}]/.test(text[i] ?? '')) i++;
    if(start===i) throw new Error('INVALID_JSON');
    JSON.parse(text.slice(start,i));
  }
  try {
    value(0);ws();if(i!==text.length) throw new Error('INVALID_JSON');
    const parsed:unknown=JSON.parse(text);
    if(!isJson(parsed)) return fail('INVALID_JSON','有限数を含むJSONが必要です');
    return ok(parsed);
  } catch(error) {const known=new Set(['INVALID_JSON','JSON_DEPTH_EXCEEDED','DUPLICATE_JSON_KEY','JSON_KEYS_EXCEEDED']);const code=error instanceof Error&&known.has(error.message)?error.message:'INVALID_JSON';return fail(code,'JSONを解釈できません');}
}
export function parseJsonBytes(bytes:Uint8Array):Result<Json> {
  if(bytes.length>MAX_JSON_BYTES) return fail('FRAME_TOO_LARGE','JSONが8MiBを超えています');
  try {return parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch {return fail('INVALID_UTF8','UTF-8が不正です');}
}
function directory():string {
  let current=dirname(fileURLToPath(import.meta.url));
  for(let n=0;n<6;n++) {const path=join(current,'contracts');if(existsSync(join(path,'task-spec.schema.json'))) return path;current=dirname(current);}
  throw new Error('CONTRACTS_NOT_FOUND');
}
export const contractDirectory=directory();
export const contracts = new Map<string,Json|string>();
const validators=new Map<string,ValidateFunction<Json>>();
const ajv=new Ajv2020({allErrors:true,strict:true});
for(const file of readdirSync(contractDirectory).sort()) {
  if(file.endsWith('.schema.json')) {
    const parsed=parseJson(readFileSync(join(contractDirectory,file),'utf8'));
    if(!parsed.ok || typeof parsed.value!=='object' || parsed.value===null || Array.isArray(parsed.value)) throw new Error(`INVALID_SCHEMA:${file}`);
    const validator=ajv.compile<Json>(parsed.value);
    contracts.set(file,parsed.value);validators.set(file,validator);
  } else if(['ports.ts','001_initial.sql','state-machine.json'].includes(file)) {
    const text=readFileSync(join(contractDirectory,file),'utf8');
    if(file.endsWith('.json')) {const parsed=parseJson(text);if(!parsed.ok) throw new Error('INVALID_STATE_MACHINE');contracts.set(file,parsed.value);}
    else contracts.set(file,text);
  }
}
if(contracts.size!==14 || validators.size!==11) throw new Error('CONTRACT_SET_INCOMPLETE');
export function validateContract(name:string,value:unknown):Result<Json> {
  if(!isJson(value))return fail('NON_JSON_VALUE','JSONとして表現できない値です');
  const key=name.endsWith('.schema.json')?name:name+'.schema.json';const validator=validators.get(key);
  if(!validator) return fail('UNKNOWN_CONTRACT','契約が存在しません',{name});
  if(!validator(value)) return fail('SCHEMA_VALIDATION_FAILED','契約に適合しません',{violations:(validator.errors??[]).map(e=>({pointer:e.instancePath,keyword:e.keyword,message:e.message??''}))});
  return ok(value);
}
