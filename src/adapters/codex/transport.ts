import type {Readable,Writable} from 'node:stream';
import type {Json,Result} from '../../../contracts/ports.js';
import type {InitializeParams} from '../../generated/codex/InitializeParams.js';
import type {InitializeResponse} from '../../generated/codex/InitializeResponse.js';
import {MAX_JSON_BYTES,parseJsonBytes} from '../../contracts/loader.js';
import {fail,ok} from '../../domain/errors.js';
import {object} from '../../domain/review.js';
type Pending={resolve:(result:Result<Json>)=>void;timer:ReturnType<typeof setTimeout>;cleanup:()=>void};
export type TransportOptions={input:Readable;output:Writable;requestTimeoutMs?:number;onNotification?:(method:string,params:Json)=>void;onUnknownServerRequest?:(method:string)=>void};
export class CodexTransport {
 private pending=new Map<number,Pending>();private nextId=0;private buffer=Buffer.alloc(0);private initialized=false;private closed=false;
 readonly notifications=new Set<(method:string,params:Json)=>void>();
 readonly serverRequests=new Set<(method:string)=>void>();
 constructor(private options:TransportOptions) {
  options.input.on('data',(chunk:Buffer)=>this.receive(chunk));
  options.input.on('end',()=>{if(this.buffer.length)this.stop('PROTOCOL_VIOLATION');else this.stop('CONNECTION_CLOSED');});
  options.input.on('error',()=>this.stop('CONNECTION_CLOSED'));options.output.on('error',()=>this.stop('CONNECTION_CLOSED'));
 }
 private write(value:Json):boolean {if(this.closed)return false;try{this.options.output.write(JSON.stringify(value)+'\n');return true;}catch{this.stop('CONNECTION_CLOSED');return false;}}
 private receive(chunk:Buffer):void {
  if(this.closed)return;
  this.buffer=Buffer.concat([this.buffer,chunk]);
  for(;;) {
   const newline=this.buffer.indexOf(10);
   if(newline<0){if(this.buffer.length>MAX_JSON_BYTES)this.stop('FRAME_TOO_LARGE');return;}
   const bytes=this.buffer.subarray(0,newline);this.buffer=this.buffer.subarray(newline+1);
   const parsed=parseJsonBytes(bytes);if(!parsed.ok){this.stop(parsed.error.code);return;}
   if(!parsed.value||typeof parsed.value!=='object'||Array.isArray(parsed.value)){this.stop('PROTOCOL_VIOLATION');return;}
   const frame=parsed.value;
   if(frame.method!==undefined&&typeof frame.method!=='string'){this.stop('PROTOCOL_VIOLATION');return;}
   if(typeof frame.method==='string') {
    if(frame.id!==undefined) {
     if(typeof frame.id!=='number'&&typeof frame.id!=='string'){this.stop('PROTOCOL_VIOLATION');return;}
     this.write({id:frame.id,error:{code:-32601,message:'このserver requestは許可されていません'}});
     this.options.onUnknownServerRequest?.(frame.method);
     for(const listener of this.serverRequests)listener(frame.method);
     continue;
    }
    this.options.onNotification?.(frame.method,frame.params??null);
    for(const listener of this.notifications)listener(frame.method,frame.params??null);
   } else if(typeof frame.id==='number') {
    const pending=this.pending.get(frame.id);if(!pending){this.stop('PROTOCOL_VIOLATION');return;}
    if((frame.result===undefined)===(frame.error===undefined)){this.stop('PROTOCOL_VIOLATION');return;}
    this.pending.delete(frame.id);clearTimeout(pending.timer);pending.cleanup();
    pending.resolve(frame.error!==undefined?fail('PROVIDER_RPC_ERROR','App Serverの要求が失敗しました',{response:frame.error}):ok(frame.result??null));
   } else {this.stop('PROTOCOL_VIOLATION');return;}
  }
 }
 private stop(code:string):void {if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.cleanup();p.resolve(fail(code,'App Serverとの接続が終了しました'));}this.pending.clear();for(const listener of this.notifications)listener('transport/closed',{code});}
 async initialize(signal?:AbortSignal):Promise<Result<void>> {
  if(this.initialized)return fail('PROTOCOL_VIOLATION','初期化済みです');
  const params={clientInfo:{name:'agent-workbench',title:'Agent Workbench',version:'0.1.0'},capabilities:null} satisfies InitializeParams;
  const response=await this.send('initialize',params,signal);
  if(!response.ok)return response;
  if(!response.value||typeof response.value!=='object'||Array.isArray(response.value))return fail('PROTOCOL_VIOLATION','initialize応答が不正です');
  const initialized=response.value;
  if(typeof initialized.userAgent!=='string'||typeof initialized.codexHome!=='string'||typeof initialized.platformFamily!=='string'||typeof initialized.platformOs!=='string')return fail('PROTOCOL_VIOLATION','initialize応答の必須fieldが不正です');
  const responseShape={userAgent:initialized.userAgent,codexHome:initialized.codexHome,platformFamily:initialized.platformFamily,platformOs:initialized.platformOs} satisfies InitializeResponse;
  if(!responseShape.codexHome.startsWith('/'))return fail('PROTOCOL_VIOLATION','Codex homeは絶対pathが必要です');
  if(!this.write({method:'initialized',params:{}}))return fail('CONNECTION_CLOSED','初期化接続が終了しました');
  this.initialized=true;return ok(undefined);
 }
 request(method:string,params:Json,signal?:AbortSignal):Promise<Result<Json>> {
  if(!this.initialized)return Promise.resolve(fail('PROTOCOL_NOT_INITIALIZED','initializeが完了していません'));
  return this.send(method,params,signal);
 }
 private send(method:string,params:Json,signal?:AbortSignal):Promise<Result<Json>> {
  if(this.closed)return Promise.resolve(fail('CONNECTION_CLOSED','接続が終了しています'));
  if(signal?.aborted)return Promise.resolve(fail('CANCELLED','要求は中断されました'));
  const id=++this.nextId;
  return new Promise(resolve=>{
   const abort=()=>{const p=this.pending.get(id);if(!p)return;this.pending.delete(id);clearTimeout(p.timer);p.cleanup();resolve(fail('EXECUTION_UNCERTAIN','送信済み要求が中断されました'));};
   const timer=setTimeout(()=>{const p=this.pending.get(id);if(!p)return;this.pending.delete(id);p.cleanup();resolve(fail('EXECUTION_UNCERTAIN','送信済み要求が時間切れです'));},this.options.requestTimeoutMs??30000);
   const cleanup=()=>signal?.removeEventListener('abort',abort);
   this.pending.set(id,{resolve,timer,cleanup});signal?.addEventListener('abort',abort,{once:true});
   if(!this.write({id,method,params})){const p=this.pending.get(id);if(p){this.pending.delete(id);clearTimeout(timer);cleanup();resolve(fail('CONNECTION_CLOSED','要求を送信できません'));}}
  });
 }
 close():void {this.stop('CONNECTION_CLOSED');this.options.output.end();}
}
