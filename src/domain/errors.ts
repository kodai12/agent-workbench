import {isJson} from './json.js';
import type { AwError, Json, Result } from '../../contracts/ports.js';
export const ok = <T>(value: T): Result<T> => ({ok:true,value});
export const fail = (code:string,message:string,details:Record<string,Json>={}):Result<never> => ({ok:false,error:{code,message,retryable:false,details}});
export function unwrap<T>(result:Result<T>):T { if(!result.ok) throw result.error; return result.value; }
export function asError(error:unknown):AwError {
  if(error && typeof error==='object' && 'code' in error && typeof error.code==='string' && 'message' in error && typeof error.message==='string') return {code:error.code,message:error.message,retryable:'retryable' in error && error.retryable===true,details:'details' in error && isJson(error.details) && error.details!==null && typeof error.details==='object' && !Array.isArray(error.details)?error.details:{}};
  return {code:'INTERNAL_ERROR',message:error instanceof Error?error.message:String(error),retryable:false,details:{}};
}
