import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Result } from '../../../contracts/ports.js';
import { asError, fail, ok } from '../../domain/errors.js';
import { syncDirectory } from './artifacts.js';

export async function appendSpool(path:string,event:AgentEvent,maximumBytes=100*1024*1024):Promise<Result<void>> {
  try {
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const handle=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    try {
      const line=Buffer.from(JSON.stringify(event)+'\n');
      if((await handle.stat()).size+line.length>maximumBytes)return fail('LOG_CAPACITY_EXCEEDED','spoolの容量上限に到達しました。');
      await handle.writeFile(line);await handle.sync();
    }finally{await handle.close();}
    await syncDirectory(dirname(path));return ok(undefined);
  }catch(error){return {ok:false,error:asError(error)};}
}
export async function recoverSpool(path:string,maximumBytes=100*1024*1024,writerQuiescent=false):Promise<Result<{events:AgentEvent[];quarantinePath:string|null}>> {
  try {
    const handle=await open(path,constants.O_RDWR|constants.O_NOFOLLOW);
    try {
      const size=(await handle.stat()).size;
      if(size>maximumBytes)return fail('LOG_CAPACITY_EXCEEDED','spoolの読取上限を超えています。');
      const bytes=Buffer.alloc(size);let read=0;
      while(read<size){const chunk=await handle.read(bytes,read,size-read,read);if(chunk.bytesRead===0)break;read+=chunk.bytesRead;}
      if(read!==size)return fail('SPOOL_CHANGED','spoolの読取中に内容が変化しました。');
      const last=bytes.lastIndexOf(10),complete=bytes.subarray(0,last+1),trailing=bytes.subarray(last+1);
      // 完全な行に不正JSONがあれば、元ファイルを変更せず停止する。
      const events=complete.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line) as AgentEvent);
      let quarantinePath:string|null=null;
      if(trailing.length){
        if(!writerQuiescent)return fail('SPOOL_WRITER_QUIESCENCE_REQUIRED','partial行の修復にはwriterの停止確認が必要です。');
        if((await handle.stat()).size!==size)return fail('SPOOL_CHANGED','spoolの読取中に追記されました。');
        quarantinePath=join(dirname(path),`partial-${randomUUID()}.jsonl`);const quarantine=await open(quarantinePath,'wx',0o600);try{await quarantine.writeFile(trailing);await quarantine.sync();}finally{await quarantine.close();}await syncDirectory(dirname(path));await handle.truncate(complete.length);await handle.sync();
      }
      return ok({events,quarantinePath});
    }finally{await handle.close();}
  }catch(error){return {ok:false,error:asError(error)};}
}
