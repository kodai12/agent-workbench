import { createConnection } from 'node:net';
import { lstat } from 'node:fs/promises';
import type { Json } from '../../contracts/ports.js';
import type { CommandRequest } from '../application/types.js';
import { MAX_JSON_BYTES,parseJsonBytes } from '../contracts/loader.js';
import { unwrap } from '../domain/errors.js';
import { readControlToken,readLockOwner,verifySocketPath,daemonError,processStartIdentity } from './lifecycle.js';

async function exchange(home:string,command:CommandRequest,timeoutMs:number,onEvent?:((event:Json)=>void),signal?:AbortSignal):Promise<Json> {
  const token=await readControlToken(home),owner=await readLockOwner(home);
  if(processStartIdentity(owner.pid)!==owner.startIdentity)throw daemonError('DAEMON_UNAVAILABLE','lock ownerのidentityが失効しています。');
  await verifySocketPath(home,owner.socketPath);
  if(owner.socketInode===undefined||(await lstat(owner.socketPath)).ino!==owner.socketInode)throw daemonError('CONTROL_SOCKET_CHANGED','lockに記録されたsocket identityが一致しません。');
  return new Promise((resolve,reject)=>{
    const socket=createConnection(owner.socketPath);let buffer=Buffer.alloc(0),authenticated=false,subscribed=false,settled=false;
    const abort=()=>finish(null,{streamEnded:true});
    const finish=(error:unknown,value:Json=null)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>finish(daemonError('TIMEOUT','daemon応答が期限内に届きません。')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
    socket.on('connect',()=>socket.write(JSON.stringify({schemaVersion:1,method:'hello',token})+'\n'));
    socket.on('error',error=>finish(error));socket.on('close',()=>finish(daemonError('CONNECTION_CLOSED','応答前にdaemon接続が切断されました。')));
    socket.on('data',(chunk:Buffer)=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.includes(10)) {
        const newline=buffer.indexOf(10),line=buffer.subarray(0,newline);buffer=buffer.subarray(newline+1);
        try {
          const parsed=unwrap(parseJsonBytes(line));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw daemonError('PROTOCOL_VIOLATION','daemon応答がobjectではありません。');
          if(subscribed&&parsed.kind==='event'){
            if(Object.keys(parsed).some(key=>!['kind','seq','event'].includes(key))||typeof parsed.seq!=='number'||!Number.isSafeInteger(parsed.seq)||parsed.seq<1||!('event'in parsed))throw daemonError('PROTOCOL_VIOLATION','event frameが不正です。');
            onEvent!(parsed);continue;
          }
          if(parsed.schemaVersion!==1||typeof parsed.ok!=='boolean')throw daemonError('PROTOCOL_VIOLATION','daemon応答のenvelopeが不正です。');
          const allowed=authenticated?['schemaVersion','requestId','ok',parsed.ok?'data':'error']:['schemaVersion','method','requestId','ok',parsed.ok?'data':'error'];
          if(Object.keys(parsed).some(key=>!allowed.includes(key))||(parsed.ok&&!('data'in parsed)))throw daemonError('PROTOCOL_VIOLATION','daemon応答に未知のfieldまたは欠落があります。');
          if(!parsed.ok){const error=parsed.error;if(!error||typeof error!=='object'||Array.isArray(error)||typeof error.code!=='string'||typeof error.message!=='string')throw daemonError('PROTOCOL_VIOLATION','daemon errorが不正です。');finish(error);return;}
          if(!authenticated){if(parsed.method!=='hello')throw daemonError('PROTOCOL_VIOLATION','hello ackが不正です。');authenticated=true;socket.write(JSON.stringify(command)+'\n');}
          else {if(parsed.requestId!==command.requestId)throw daemonError('PROTOCOL_VIOLATION','requestIdが一致しません。');if(onEvent){subscribed=true;clearTimeout(timer);}else{finish(null,parsed.data??null);return;}}
        }catch(error){finish(error);return;}
      }
      if(buffer.length>MAX_JSON_BYTES)finish(daemonError('FRAME_TOO_LARGE','daemon応答が8MiBを超えています。'));
    });
  });
}
export function request(home:string,command:CommandRequest,timeoutMs=30_000):Promise<Json> {return exchange(home,command,timeoutMs);}
export function subscribe(home:string,command:CommandRequest,onEvent:(event:Json)=>void,signal:AbortSignal,timeoutMs=30_000):Promise<Json> {return exchange(home,command,timeoutMs,onEvent,signal);}
