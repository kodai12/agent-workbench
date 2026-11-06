import { createServer, type Socket } from 'node:net';
import { chmod, lstat, unlink, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Actor, Json, AwError } from '../../contracts/ports.js';
import type { CommandRequest } from '../application/types.js';
import { MAX_JSON_BYTES,parseJsonBytes } from '../contracts/loader.js';
import { asError, unwrap } from '../domain/errors.js';
import { syncDirectory } from '../adapters/filesystem/artifacts.js';
import { acquireDaemonLock,daemonError,readControlToken,readLockOwner,prepareSocketDirectory } from './lifecycle.js';

export interface DaemonService {dispatch(request:CommandRequest,actor:Actor):Promise<Json>;reconcile():Promise<void>;close():void;events?(after:number,aggregateId?:string):Json[];}
const READ_METHODS=new Set(['repo.list','repo.get','repo.syncPlan','task.list','task.get','task.logs','task.attach','task.diff','findings.list','findings.get','finding.get','approval.get','board.get','board.memo','history.query','gc.plan','config.show','system.doctor','doctor','daemon.status','events.subscribe']);
const CREATE_METHODS=new Set(['repo.add','task.create','board.create','handoff.create','backup.create','backup.restore','policy.import','profiles.configure','daemon.stop']);
export function validateRequest(value:Json):CommandRequest {
  if(!value||typeof value!=='object'||Array.isArray(value))throw daemonError('INVALID_INPUT','RPC envelopeはobjectに限ります。');
  if(Object.keys(value).some(key=>!['schemaVersion','requestId','method','expectedVersion','params'].includes(key))||value.schemaVersion!==1||typeof value.requestId!=='string'||!value.requestId||value.requestId.length>160||typeof value.method!=='string'||!value.method||!('expectedVersion'in value)||!value.params||typeof value.params!=='object'||Array.isArray(value.params))throw daemonError('INVALID_INPUT','RPC envelopeが不正です。');
  if(Object.keys(value.params).some(key=>['actor','actorKind','actorId','connectionId','workerInstanceId','nonce'].includes(key)))throw daemonError('PERMISSION_DENIED','接続identityを要求内で指定できません。');
  if(value.expectedVersion!==null&&(!Number.isSafeInteger(value.expectedVersion)||typeof value.expectedVersion!=='number'||value.expectedVersion<1))throw daemonError('INVALID_INPUT','expectedVersionは正の整数かnullに限ります。');
  if(!READ_METHODS.has(value.method)&&!CREATE_METHODS.has(value.method)&&value.expectedVersion===null)throw daemonError('EXPECTED_VERSION_REQUIRED','更新要求にはexpectedVersionが必要です。');
  if(CREATE_METHODS.has(value.method)&&value.expectedVersion!==null)throw daemonError('INVALID_INPUT','create要求のexpectedVersionはnullに限ります。');
  return value as CommandRequest;
}
export async function startServer(home:string,factory:()=>DaemonService):Promise<{socketPath:string;close():Promise<void>}> {
  const lock=await acquireDaemonLock(home);let service:DaemonService|undefined;
  const sockets=new Set<Socket>(),pending=new Set<Promise<void>>();let closing=false,reconciling=false;
  let reconcileFailure:AwError|null=null;
  let socketInode:number|undefined;let timer:ReturnType<typeof setInterval>|undefined;
  const server=createServer();
  let closingPromise:Promise<void>|undefined;
  const close=():Promise<void>=>{
    if(closingPromise)return closingPromise;
    closingPromise=(async()=>{closing=true;if(timer)clearInterval(timer);
    for(const socket of sockets)socket.destroy();
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await Promise.allSettled([...pending]);
    try{service?.close();}finally{
      try{const current=await readLockOwner(home),stat=await lstat(lock.owner.socketPath);if(current.instanceId===lock.owner.instanceId&&stat.ino===socketInode&&stat.isSocket())await unlink(lock.owner.socketPath);}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
      await lock.release();
    }
    })();return closingPromise;
  };
  try {
    const token=await readControlToken(home);await prepareSocketDirectory(home,lock.owner.socketPath);
    try{await lstat(lock.owner.socketPath);throw daemonError('CONTROL_SOCKET_EXISTS','既存socketを自動削除しません。lock recoveryを実行してください。');}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
    service=factory();await service.reconcile();
    server.on('connection',socket=>{
      sockets.add(socket);let buffer=Buffer.alloc(0),authenticated=false,queued=0,queuedBytes=0,rejected=false,subscriber:{after:number;aggregateId?:string}|undefined;
      const actor:Actor={kind:'human',id:`uid:${process.getuid?.()??'unknown'}`,connectionId:randomUUID()};
      let serial=Promise.resolve();const helloTimer=setTimeout(()=>socket.destroy(),5000);helloTimer.unref();
      const send=(value:unknown)=>{
        if(socket.destroyed)return;const frame=JSON.stringify(value);
        if(Buffer.byteLength(frame)>MAX_JSON_BYTES){const requestId=value&&typeof value==='object'&&'requestId'in value?value.requestId:null;socket.write(JSON.stringify({schemaVersion:1,requestId,ok:false,error:daemonError('FRAME_TOO_LARGE','RPC応答が8MiBを超えています。')})+'\n');return;}
        socket.write(frame+'\n');
      };
      const reject=(error:unknown,requestId:string|null=null,disconnect=false)=>{send({schemaVersion:1,requestId,ok:false,error:asError(error)});if(disconnect){rejected=true;socket.end();}};
      const slow=()=>{reject(daemonError('SLOW_CONSUMER','購読queueの上限に達しました。最後のseqから再購読してください。'),null,true);const stop=setTimeout(()=>socket.destroy(),100);stop.unref();subscriber=undefined;};
      const poll=()=>{
        if(!subscriber||!service?.events||socket.destroyed)return;
        try {
          const events=service.events(subscriber.after,subscriber.aggregateId).slice(0,128);
          for(const event of events){
            if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.seq!=='number'||!Number.isSafeInteger(event.seq)||event.seq<=subscriber.after)throw daemonError('PROTOCOL_VIOLATION','eventの総順序seqが不正です。');
            const frame=JSON.stringify({kind:'event',seq:event.seq,event})+'\n';
            if(Buffer.byteLength(frame)>MAX_JSON_BYTES||socket.writableLength+Buffer.byteLength(frame)>1024*1024){slow();return;}
            socket.write(frame);subscriber.after=event.seq;
          }
        }catch(error){reject(error,null,true);subscriber=undefined;}
      };
      const subscriptionTimer=setInterval(poll,200);subscriptionTimer.unref();
      socket.on('close',()=>{sockets.delete(socket);clearTimeout(helloTimer);clearInterval(subscriptionTimer);});socket.on('error',()=>{});
      const handle=async(line:Buffer)=>{
        if(rejected||socket.destroyed)return;
        let requestId:string|null=null;
        try {
          const value=unwrap(parseJsonBytes(line));
          if(!authenticated){
            if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['schemaVersion','method','token'].includes(key))||value.schemaVersion!==1||value.method!=='hello'||typeof value.token!=='string')throw daemonError('PERMISSION_DENIED','control tokenのhello handshakeが必要です。');
            const supplied=Buffer.from(value.token),expected=Buffer.from(token);
            if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw daemonError('PERMISSION_DENIED','control tokenが一致しません。');
            authenticated=true;clearTimeout(helloTimer);send({schemaVersion:1,method:'hello',ok:true,data:{instanceId:lock.owner.instanceId}});return;
          }
          const request=validateRequest(value);requestId=request.requestId;
          if(closing)throw daemonError('DAEMON_STOPPING','daemonは停止中です。');
          if(['daemon.status','daemon.stop'].includes(request.method)&&Object.keys(request.params).length)throw daemonError('INVALID_INPUT','daemon操作のparamsは空objectに限ります。');
          if(request.method==='daemon.status'){send({schemaVersion:1,requestId,ok:true,data:{pid:process.pid,instanceId:lock.owner.instanceId,socketPath:lock.owner.socketPath,recoveryError:reconcileFailure}});return;}
          if(request.method==='daemon.stop'){send({schemaVersion:1,requestId,ok:true,data:{stopping:true}});socket.end();setImmediate(()=>{void close();});return;}
          if(request.method==='events.subscribe'){
            if(!service?.events)throw daemonError('CAPABILITY_MISSING','event購読を利用できません。');
            if(Object.keys(request.params).some(key=>!['afterSeq','taskId'].includes(key))||typeof request.params.afterSeq!=='number'||!Number.isSafeInteger(request.params.afterSeq)||request.params.afterSeq<0||(request.params.taskId!==undefined&&typeof request.params.taskId!=='string'))throw daemonError('INVALID_INPUT','event購読条件が不正です。');
            subscriber={after:request.params.afterSeq,...(typeof request.params.taskId==='string'?{aggregateId:request.params.taskId}:{})};send({schemaVersion:1,requestId,ok:true,data:{subscribed:true}});poll();return;
          }
          if(reconcileFailure&&!READ_METHODS.has(request.method))throw daemonError('RECOVERY_REQUIRED','直前のreconciliationに失敗したため更新を停止しています。');
          const data=await service!.dispatch(request,actor);send({schemaVersion:1,requestId,ok:true,data});
        }catch(error){reject(error,requestId,!authenticated);}
      };
      socket.on('data',(chunk:Buffer)=>{
        buffer=Buffer.concat([buffer,chunk]);
        for(;;){const newline=buffer.indexOf(10);if(newline<0)break;
          if(newline>MAX_JSON_BYTES){reject(daemonError('FRAME_TOO_LARGE','RPC frameが8MiBを超えています。'),null,true);return;}
          const line=Buffer.from(buffer.subarray(0,newline));buffer=buffer.subarray(newline+1);
          queuedBytes+=line.length;
          if(++queued>64||queuedBytes>16*1024*1024){slow();return;}
          const work=serial.then(()=>handle(line)).finally(()=>{queued--;queuedBytes-=line.length;pending.delete(work);});serial=work;pending.add(work);
        }
        if(buffer.length>MAX_JSON_BYTES){reject(daemonError('FRAME_TOO_LARGE','RPC frameが8MiBを超えています。'),null,true);}
      });
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(lock.owner.socketPath,()=>{server.off('error',reject);resolve();});});
    await chmod(lock.owner.socketPath,0o600);socketInode=(await lstat(lock.owner.socketPath)).ino;
    const ownerTemp=join(home,'daemon.lock',`.owner-${lock.owner.instanceId}.tmp`),ownerHandle=await open(ownerTemp,'wx',0o600);
    try{await ownerHandle.writeFile(JSON.stringify({...lock.owner,socketInode}));await ownerHandle.sync();}finally{await ownerHandle.close();}
    await rename(ownerTemp,join(home,'daemon.lock','owner.json'));await syncDirectory(join(home,'daemon.lock'));
    timer=setInterval(()=>{if(reconciling||closing)return;reconciling=true;const work=Promise.resolve().then(()=>service!.reconcile()).then(()=>{reconcileFailure=null;},error=>{reconcileFailure=asError(error);}).finally(()=>{reconciling=false;pending.delete(work);});pending.add(work);},500);timer.unref();
    return {socketPath:lock.owner.socketPath,close};
  }catch(error){await close();throw error;}
}
