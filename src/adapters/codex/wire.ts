import {Ajv,type ValidateFunction} from 'ajv';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Result} from '../../../contracts/ports.js';
import {fail,ok} from '../../domain/errors.js';
const ajv=new Ajv({strict:false,allErrors:true});
for(const [format,minimum,maximum] of [['uint16',0,65535],['uint32',0,4294967295],['uint',0,Number.MAX_SAFE_INTEGER],['uint64',0,Number.MAX_SAFE_INTEGER],['int32',-2147483648,2147483647],['int64',Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]] as const)ajv.addFormat(format,{type:'number',validate:value=>Number.isSafeInteger(value)&&value>=minimum&&value<=maximum});
ajv.addFormat('double',{type:'number',validate:Number.isFinite});
function directory():string{let path=dirname(fileURLToPath(import.meta.url));for(let i=0;i<7;i++){const candidate=join(path,'src/generated/codex-json');if(existsSync(candidate))return candidate;path=dirname(path);}throw new Error('CODEX_SCHEMA_MISSING');}
const schemas=directory();
export function validateWire<T>(name:string,value:unknown):Result<T> {
 const key='codex:'+name;let validate=ajv.getSchema<T>(key);
 if(!validate){const path=join(schemas,name+'.json');if(!existsSync(path))return fail('PROTOCOL_SCHEMA_MISSING','捕捉schemaがありません',{schema:name});const schema:unknown=JSON.parse(readFileSync(path,'utf8'));if(!schema||typeof schema!=='object'||Array.isArray(schema))return fail('PROTOCOL_VIOLATION','wire schemaが不正です');ajv.addSchema(schema,key);validate=ajv.getSchema<T>(key);}
 const checked:ValidateFunction<T>|undefined=validate;
 if(!checked||!checked(value))return fail('PROTOCOL_VIOLATION','捕捉したwire契約に適合しません',{schema:name});
 return ok(value);
}
