import { mkdir, lstat, realpath, readFile, open, unlink, rmdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ensureDirectory } from '../adapters/filesystem/paths.js';
import { syncDirectory } from '../adapters/filesystem/artifacts.js';

export interface LockOwner {instanceId:string;pid:number;startIdentity:string;socketPath:string;socketInode?:number;}
export const daemonError=(code:string,message:string,details:Record<string,string|number>={})=>({code,message,retryable:false,details});
export function processStartIdentity(pid:number):string|null {
  try {process.kill(pid,0);}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ESRCH')return null;throw daemonError('PROCESS_IDENTITY_UNKNOWN','processの生存を確認できません。');}
  const start=spawnSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
  if(start.status!==0||!start.stdout.trim())throw daemonError('PROCESS_IDENTITY_UNKNOWN','process start identityを確認できません。');
  const boot=process.platform==='darwin'?spawnSync('/usr/sbin/sysctl',['-n','kern.boottime'],{encoding:'utf8'}).stdout.trim():readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  if(!boot)throw daemonError('PROCESS_IDENTITY_UNKNOWN','boot identityを確認できません。');
  return `${boot}:${start.stdout.trim()}`;
}
export function socketPathFor(home:string):string {
  const normal=join(resolve(home),'control.sock');
  return Buffer.byteLength(normal)<95?normal:join('/tmp',`aw-${process.getuid?.()??'unknown'}`,createHash('sha256').update(resolve(home)).digest('hex').slice(0,16),'control.sock');
}
export async function prepareSocketDirectory(home:string,path:string):Promise<void> {
  if(dirname(path)===resolve(home)){await verifyPrivate(home,'directory');return;}
  const runtime=dirname(dirname(path));ensureDirectory(runtime);await verifyPrivate(runtime,'directory');
  ensureDirectory(runtime,[basename(dirname(path))]);await verifyPrivate(dirname(path),'directory');
}
export async function verifySocketPath(home:string,path:string):Promise<void> {
  if(path!==socketPathFor(home))throw daemonError('UNSAFE_CONTROL_PATH','socket pathがhomeに対応しません。');
  if(dirname(path)!==resolve(home))await verifyPrivate(dirname(dirname(path)),'directory');
  await verifyPrivate(dirname(path),'directory');await verifyPrivate(path,'socket');
}
export async function verifyPrivate(path:string,type:'directory'|'file'|'socket'):Promise<void> {
  const stat=await lstat(path);
  if(stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||(type==='directory'?!stat.isDirectory():type==='file'?!stat.isFile():!stat.isSocket()))throw daemonError('UNSAFE_CONTROL_PATH','所有者、permission、file種別の検査に失敗しました。');
}
export async function readControlToken(home:string):Promise<string> {
  await verifyPrivate(home,'directory');await verifyPrivate(join(home,'control-token'),'file');
  if(await realpath(join(home,'control-token'))!==join(await realpath(home),'control-token'))throw daemonError('UNSAFE_CONTROL_PATH','tokenの実pathがhome外へ出ています。');
  const token=(await readFile(join(home,'control-token'),'utf8')).trim();
  if(!/^[a-f0-9]{64}$/.test(token))throw daemonError('INVALID_CONTROL_TOKEN','control tokenが不正です。');return token;
}
export async function readLockOwner(home:string):Promise<LockOwner> {
  await verifyPrivate(join(home,'daemon.lock'),'directory');await verifyPrivate(join(home,'daemon.lock','owner.json'),'file');
  if(await realpath(join(home,'daemon.lock'))!==join(await realpath(home),'daemon.lock'))throw daemonError('UNSAFE_CONTROL_PATH','lockの実pathがhome外へ出ています。');
  const owner=JSON.parse(await readFile(join(home,'daemon.lock','owner.json'),'utf8')) as LockOwner;
  if(typeof owner.instanceId!=='string'||!Number.isSafeInteger(owner.pid)||owner.pid<=0||typeof owner.startIdentity!=='string'||owner.socketPath!==socketPathFor(home))throw daemonError('INVALID_DAEMON_LOCK','daemon lockのidentityが不正です。');
  return owner;
}
export async function acquireDaemonLock(home:string):Promise<{owner:LockOwner;release():Promise<void>}> {
  ensureDirectory(home);await verifyPrivate(home,'directory');const lock=join(home,'daemon.lock');
  try{await mkdir(lock,{mode:0o700});}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST')throw daemonError('DAEMON_ALREADY_RUNNING','既存daemon lockがあります。statusを確認してください。');throw error;}
  const identity=processStartIdentity(process.pid);
  if(identity===null)throw daemonError('PROCESS_IDENTITY_UNKNOWN','daemon自身のidentityを取得できません。');
  const owner:LockOwner={instanceId:randomUUID(),pid:process.pid,startIdentity:identity,socketPath:socketPathFor(home)};
  const handle=await open(join(lock,'owner.json'),'wx',0o600);try{await handle.writeFile(JSON.stringify(owner));await handle.sync();}finally{await handle.close();}await syncDirectory(lock);await syncDirectory(home);
  const inode=(await lstat(lock)).ino;
  return {owner,async release(){try{const current=await readLockOwner(home);if(current.instanceId!==owner.instanceId||(await lstat(lock)).ino!==inode)return;await unlink(join(lock,'owner.json'));await rmdir(lock);await syncDirectory(home);}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}}};
}
export async function recoverDaemonLock(home:string):Promise<void> {
  await verifyPrivate(home,'directory');const recovery=join(home,'daemon-recovery.lock');
  try{await mkdir(recovery,{mode:0o700});}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST')throw daemonError('RECOVERY_BUSY','別のlock recoveryが進行中です。');throw error;}
  try {
    const owner=await readLockOwner(home),current=processStartIdentity(owner.pid);
    if(current===owner.startIdentity)throw daemonError('DAEMON_STILL_RUNNING','lock ownerが生存しているため回収できません。');
    const again=await readLockOwner(home);if(again.instanceId!==owner.instanceId)throw daemonError('DAEMON_LOCK_CHANGED','lock ownerが変化しました。');
    try{await verifyPrivate(owner.socketPath,'socket');if(owner.socketInode===undefined||(await lstat(owner.socketPath)).ino!==owner.socketInode)throw daemonError('CONTROL_SOCKET_CHANGED','socket identityが不明なため削除しません。');await unlink(owner.socketPath);}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
    await unlink(join(home,'daemon.lock','owner.json'));await rmdir(join(home,'daemon.lock'));await syncDirectory(home);
  }finally{await rmdir(recovery);}
}
