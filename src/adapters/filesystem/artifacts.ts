import { constants } from 'node:fs';
import { open, link, unlink, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { ArtifactStore, Digest, Result, ArtifactRef } from '../../../contracts/ports.js';
import { asError, fail, ok } from '../../domain/errors.js';
import { ensureDirectory } from './paths.js';

const LIMIT=100*1024*1024;
const digestOf=(bytes:Uint8Array):Digest=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export async function syncDirectory(path:string):Promise<void> { const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();} }
export function artifactPath(home:string,digest:Digest):string {
  if(!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('INVALID_ARTIFACT_DIGEST');
  return join(home,'objects','sha256',digest.slice(7,9),digest.slice(9));
}
export function createArtifactStore(home:string):ArtifactStore {
  return {
    async put(bytes:Uint8Array,mediaType:string,maximumBytes:number):Promise<Result<ArtifactRef>> {
      if(!Number.isSafeInteger(maximumBytes)||maximumBytes<0||bytes.byteLength>maximumBytes||bytes.byteLength>LIMIT) return fail('ARTIFACT_TOO_LARGE','artifactの保存上限を超えています。');
      bytes=Buffer.from(bytes);
      const digest=digestOf(bytes),path=artifactPath(home,digest),directory=join(path,'..');
      let temporary:string|undefined;
      try {
        ensureDirectory(home,['objects','sha256',digest.slice(7,9)]);
        temporary=join(directory,`.${randomUUID()}.tmp`);
        const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
        // linkは既存objectを上書きせず、同filesystem上で完成した内容を公開する。
        try {await link(temporary,path);}catch(error){if(!(error && typeof error==='object' && 'code'in error && error.code==='EEXIST')) throw error; const existing=await this.readVerified(digest);if(!existing.ok)return existing;}
        await unlink(temporary);temporary=undefined;await syncDirectory(directory);
        return ok({digest,mediaType,sizeBytes:bytes.byteLength});
      }catch(error){return {ok:false,error:asError(error)};}finally{if(temporary)await unlink(temporary).catch(()=>{});}
    },
    async readVerified(digest:Digest):Promise<Result<Uint8Array>> {
      try {
        const path=artifactPath(home,digest),root=await realpath(home),directory=join(path,'..');
        if(await realpath(directory)!==resolve(root,directory.slice(resolve(home).length+1))) return fail('ARTIFACT_PATH_ESCAPE','artifactの格納先がhomeの外へ出ています。');
        const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        try {
          const stat=await handle.stat();
          if(!stat.isFile())return fail('ARTIFACT_INVALID','artifactが通常ファイルではありません。');
          if(stat.size>LIMIT)return fail('ARTIFACT_TOO_LARGE','artifactの読取上限を超えています。');
          const bytes=Buffer.alloc(stat.size);let read=0;
          while(read<bytes.length){const chunk=await handle.read(bytes,read,bytes.length-read,read);if(chunk.bytesRead===0)break;read+=chunk.bytesRead;}
          const after=await handle.stat();
          if(read!==stat.size||after.size!==stat.size||digestOf(bytes)!==digest)return fail('ARTIFACT_CORRUPT','artifactの内容がdigestと一致しません。');
          return ok(bytes);
        }finally{await handle.close();}
      }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return fail('ARTIFACT_MISSING','参照先artifactが存在しません。');return {ok:false,error:asError(error)};}
    }
  };
}
