import Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { cp, mkdir, readFile, readdir, lstat, open, realpath, rename } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Digest, Result } from '../../../contracts/ports.js';
import { asError, fail, ok, unwrap } from '../../domain/errors.js';
import { artifactPath, createArtifactStore, syncDirectory } from '../filesystem/artifacts.js';
import { openStore, type Store } from './store.js';
import { ensureDirectory } from '../filesystem/paths.js';

interface BackupManifest {
  schemaVersion:1; createdAtMs:number; cutoffEventSeq:number;
  spoolPolicy:'excluded-replay-from-worker-after-cutoff';
  files:{path:string;digest:string}[];
}
async function fileHash(path:string):Promise<string> {
  const hash=createHash('sha256');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{for await(const bytes of handle.createReadStream({autoClose:false}))hash.update(bytes);}finally{await handle.close();}
  return hash.digest('hex');
}
async function exists(path:string):Promise<boolean> {
  try{await lstat(path);return true;}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return false;throw error;}
}
async function filesBelow(root:string):Promise<string[]> {
  if((await lstat(root)).isSymbolicLink())throw new Error('BACKUP_SYMLINK_REJECTED');
  const files:string[]=[];
  for(const entry of await readdir(root,{withFileTypes:true})) {
    const path=join(root,entry.name);
    if(entry.isSymbolicLink())throw new Error('BACKUP_SYMLINK_REJECTED');
    if(entry.isDirectory())files.push(...await filesBelow(path));
    else if(entry.isFile())files.push(path);
    else throw new Error('BACKUP_SPECIAL_FILE_REJECTED');
  }
  return files;
}
async function durableCopy(source:string,destination:string):Promise<void> {
  if((await lstat(source)).isSymbolicLink())throw new Error('BACKUP_SYMLINK_REJECTED');
  await mkdir(dirname(destination),{recursive:true,mode:0o700});
  await cp(source,destination,{errorOnExist:true,force:false});
  const handle=await open(destination,'r');try{await handle.sync();}finally{await handle.close();}
  await syncDirectory(dirname(destination));
}
export async function backupStore(store:Store,destination:string):Promise<Result<BackupManifest>> {
  // 呼出側はmanaged Git/configの更新を停止する。worker spoolは継続できる。
  try {
    if(store.db.inTransaction)return fail('TRANSACTION_ACTIVE','backupをtransaction内で開始できません。');
    if(['repos','objects','protocol-captures'].some(name=>{const source=resolve(store.home,name);return resolve(destination)===source||resolve(destination).startsWith(source+'/');}))return fail('INVALID_BACKUP_DESTINATION','backup対象directory内を出力先にできません。');
    await mkdir(destination,{mode:0o700});await mkdir(join(destination,'db'),{mode:0o700});
    await store.db.backup(join(destination,'db','state.sqlite'));
    const snapshot=new Database(join(destination,'db','state.sqlite'));
    let digests:{digest:Digest}[],cutoff:number;
    try {
      snapshot.pragma('journal_mode=DELETE');
      if(snapshot.pragma('integrity_check',{simple:true})!=='ok')throw new Error('BACKUP_INTEGRITY_FAILED');
      cutoff=(snapshot.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get() as {seq:number}).seq;
      digests=snapshot.prepare('SELECT digest FROM artifacts').all() as {digest:Digest}[];
    }finally{snapshot.close();}
    const artifacts=createArtifactStore(store.home);
    for(const {digest} of digests){unwrap(await artifacts.readVerified(digest));await durableCopy(artifactPath(store.home,digest),artifactPath(destination,digest));unwrap(await createArtifactStore(destination).readVerified(digest));}
    for(const name of ['repos','protocol-captures']) {
      const source=join(store.home,name);
      if(await exists(source))for(const path of await filesBelow(source))await durableCopy(path,join(destination,name,relative(source,path)));
    }
    for(const name of ['config.json','protocol-lock.json']) {
      if(await exists(join(store.home,name)))await durableCopy(join(store.home,name),join(destination,name));
    }
    const manifest:BackupManifest={schemaVersion:1,createdAtMs:Date.now(),cutoffEventSeq:cutoff,spoolPolicy:'excluded-replay-from-worker-after-cutoff',files:[]};
    for(const path of await filesBelow(destination)){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}manifest.files.push({path:relative(destination,path),digest:await fileHash(path)});}
    const handle=await open(join(destination,'manifest.json'),'wx',0o600);try{await handle.writeFile(JSON.stringify(manifest));await handle.sync();}finally{await handle.close();}
    await syncDirectory(destination);await syncDirectory(dirname(destination));return ok(manifest);
  }catch(error){return {ok:false,error:asError(error)};}
}
export async function restoreStore(backup:string,destination:string):Promise<Result<{cutoffEventSeq:number}>> {
  try {
    const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8')) as BackupManifest;
    if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||!manifest.files.some(file=>file.path==='db/state.sqlite'))return fail('INVALID_BACKUP','backup manifestが不正です。');
    for(const file of manifest.files) {
      if(typeof file.path!=='string'||file.path.includes('\0')||file.path.includes('\n')||file.path.split(/[\\/]/).includes('..')||resolve(backup,file.path)!==join(resolve(backup),file.path))return fail('INVALID_BACKUP_PATH','backup内pathが不正です。');
      if(!/^(config\.json|protocol-lock\.json|db\/state\.sqlite|objects\/sha256\/[a-f0-9]{2}\/[a-f0-9]{62}|repos\/([^/]+\.git\/.+|[^/]+\.json)|protocol-captures\/.+)$/.test(file.path))return fail('INVALID_BACKUP_PATH','backup対象外のpathです。');
      if(await realpath(join(backup,file.path))!==join(await realpath(backup),file.path))return fail('INVALID_BACKUP_PATH','backup内のsymlinkは使用できません。');
      if(await fileHash(join(backup,file.path))!==file.digest)return fail('BACKUP_CORRUPT','backupのchecksumが一致しません。');
    }
    await mkdir(destination,{mode:0o700});
    for(const file of manifest.files)await durableCopy(join(backup,file.path),join(destination,file.path));
    const restoredHome=await realpath(destination),store=unwrap(openStore(restoredHome));
    try {
      const repositories=store.db.prepare('SELECT id FROM repositories').all() as {id:string}[];
      const safeId=(id:string)=>{if(!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw new Error('INVALID_RESTORED_ID');return id;};
      for(const {id} of repositories){
        safeId(id);const managedPath=join(restoredHome,'repos',id+'.git'),metadata=join(restoredHome,'repos',id+'.json');
        if(await exists(metadata)){
          const record=JSON.parse(await readFile(metadata,'utf8')) as Record<string,unknown>;
          // commonDir/sourceCommonDirは外部sourceの読取identityなので移動しない。
          record.managedPath=managedPath;
          const handle=await open(metadata,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW);
          try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}
          await syncDirectory(dirname(metadata));
        }
        const staleMetadata=join(managedPath,'worktrees');
        if(await exists(staleMetadata)){
          const quarantine=ensureDirectory(restoredHome,['recovery','git-worktrees']);
          await rename(staleMetadata,join(quarantine,id));await syncDirectory(managedPath);await syncDirectory(quarantine);
        }
      }
      store.transact(()=>{
        for(const {id} of repositories)store.db.prepare('UPDATE repositories SET managed_git_dir=? WHERE id=?').run(join(restoredHome,'repos',id+'.git'),id);
        for(const workspace of store.db.prepare('SELECT id,repo_id FROM workspaces').all() as {id:string;repo_id:string}[]){
          const path=join(restoredHome,'workspaces',safeId(workspace.repo_id),safeId(workspace.id));
          // checkout本体はbackup対象外。存在しない旧workspaceをreadyとして再利用しない。
          store.db.prepare("UPDATE workspaces SET path=?,state=CASE WHEN state='removed' THEN 'removed' ELSE 'quarantined' END WHERE id=?").run(path,workspace.id);
        }
        store.db.prepare('UPDATE approvals SET revoked_at_ms=? WHERE consumed_by_command_id IS NULL AND revoked_at_ms IS NULL').run(Date.now());
        store.db.prepare("UPDATE approval_requests SET state='revoked' WHERE state IN ('pending','granted')").run();
        store.db.prepare("UPDATE attempts SET state='unknown' WHERE state IN ('created','starting','running','waiting_input','stopping')").run();
        store.db.prepare('UPDATE attempts SET worker_socket=NULL,process_identity_json=NULL,presentation_json=NULL').run();
        store.db.prepare("UPDATE tasks SET state='recovery_required',version=version+1 WHERE state IN ('allocating','running','waiting_human','freezing','verifying','reviewing','awaiting_approval','integrating')").run();
        store.db.prepare("UPDATE leases SET status='recovery_required' WHERE status='held'").run();
        store.db.prepare("UPDATE commands SET state='uncertain',updated_at_ms=? WHERE state='executing'").run(Date.now());
        store.db.prepare("UPDATE integrations SET state='uncertain' WHERE state='prepared'").run();
      });
      for(const row of store.db.prepare('SELECT digest FROM artifacts').all() as {digest:Digest}[])unwrap(await createArtifactStore(destination).readVerified(row.digest));
    }finally{store.close();}
    return ok({cutoffEventSeq:manifest.cutoffEventSeq});
  }catch(error){return {ok:false,error:asError(error)};}
}
export interface WorkspaceGcObservation { id:string; stopped:boolean; dirty:boolean|null; retentionExpired:boolean; artifactsSaved:boolean; merged:boolean; }
export function planWorkspaceGc(store:Store,observations:WorkspaceGcObservation[]):{id:string;path:string;taskId:string|null;branchRef:string|null;dirty:boolean|null;eligible:boolean;reasons:string[]}[] {
  return (store.db.prepare("SELECT id,path,task_id,branch_ref,role,state FROM workspaces WHERE state<>'removed'").all() as {id:string;path:string;task_id:string|null;branch_ref:string|null;role:string;state:string}[]).map(row=>{
    const observation=observations.find(item=>item.id===row.id),reasons:string[]=[];
    if(!['check','review'].includes(row.role))reasons.push('ROLE_PROTECTED');
    if(!observation?.stopped)reasons.push('STOP_UNCONFIRMED');
    if(observation?.dirty!==false)reasons.push('DIRTY_OR_UNKNOWN');
    if(!observation?.retentionExpired)reasons.push('RETENTION_ACTIVE');
    if(!observation?.artifactsSaved)reasons.push('ARTIFACTS_UNCONFIRMED');
    if(row.branch_ref&&!observation?.merged)reasons.push('UNMERGED_BRANCH');
    if(row.state==='quarantined')reasons.push('QUARANTINED');
    if(store.db.prepare("SELECT 1 FROM attempts WHERE workspace_id=? AND state IN ('created','starting','running','waiting_input','stopping','unknown')").get(row.id))reasons.push('ACTIVE_OR_UNKNOWN_ATTEMPT');
    return {id:row.id,path:row.path,taskId:row.task_id,branchRef:row.branch_ref,dirty:observation?.dirty??null,eligible:reasons.length===0,reasons};
  });
}
export async function planObjectGc(store:Store,backupReferenced:Digest[]):Promise<Result<{digest:Digest;eligible:boolean;reason:string}[]>> {
  const pending=store.db.prepare("SELECT count(*) AS count FROM commands WHERE state IN ('pending','executing','uncertain')").get() as {count:number};
  const referenced=new Set((store.db.prepare('SELECT digest FROM artifacts').all() as {digest:Digest}[]).map(row=>row.digest));
  const objects:{digest:Digest;eligible:boolean;reason:string}[]=[];
  try {
    const root=join(store.home,'objects','sha256');
    for(const path of await filesBelow(root)) {
      const hex=relative(root,path).split(/[\\/]/).join('');
      if(!/^[a-f0-9]{64}$/.test(hex))continue;
      const digest:Digest=`sha256:${hex}`;
      // 未完了commandの自由形式JSONの到達性を推測せず、全objectを保全する。
      const reason=pending.count?'PENDING_COMMANDS':referenced.has(digest)?'DB_REFERENCED':backupReferenced.includes(digest)?'BACKUP_REFERENCED':'ORPHAN_OBJECT';
      objects.push({digest,eligible:reason==='ORPHAN_OBJECT',reason});
    }
    return ok(objects);
  }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return ok(objects);return {ok:false,error:asError(error)};}
}
