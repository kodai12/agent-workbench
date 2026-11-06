import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,lstat,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConnection} from 'node:net';
import {randomBytes} from 'node:crypto';
import {startServer,validateRequest} from '../../src/daemon/server.js';
import {request} from '../../src/daemon/client.js';
import {recoverDaemonLock,acquireDaemonLock} from '../../src/daemon/lifecycle.js';
import type {CommandRequest} from '../../src/application/types.js';
import type {Actor,Json} from '../../contracts/ports.js';

async function homeFixture(){const home=await mkdtemp(join(tmpdir(),'aw-daemon-'));await chmod(home,0o700);const token=randomBytes(32).toString('hex');await writeFile(join(home,'control-token'),token,{mode:0o600});return {home,token};}
const command=(method='task.get',expectedVersion:number|null=null,params:{[key:string]:Json}={}):CommandRequest=>({schemaVersion:1,requestId:randomBytes(16).toString('hex'),method,expectedVersion,params});
async function raw(path:string,lines:(string|Buffer)[],maximum=2):Promise<Json[]> {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(path);let buffer='',result:Json[]=[];
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('raw RPC timeout'));},3000);
    const done=()=>{clearTimeout(timer);socket.destroy();resolve(result);};
    socket.on('connect',()=>{for(const line of lines)socket.write(line);});socket.on('error',reject);socket.on('close',done);
    socket.on('data',chunk=>{buffer+=chunk.toString('utf8');while(buffer.includes('\n')){const i=buffer.indexOf('\n');result.push(JSON.parse(buffer.slice(0,i)) as Json);buffer=buffer.slice(i+1);if(result.length>=maximum){done();return;}}});
  });
}
test('control token handshakeと接続由来actorを使い、二重daemonでfactoryを呼ばない',async()=>{
  const {home}=await homeFixture();let factories=0,actor:Actor|undefined,closed=0;
  const factory=()=>{factories++;return {async dispatch(_request:CommandRequest,value:Actor){actor=value;return {done:true};},async reconcile(){},close(){closed++;}};};
  const server=await startServer(home,factory);
  try {
    assert.deepEqual(await request(home,command()),{done:true});assert.equal(actor?.kind,'human');
    assert.equal((await lstat(server.socketPath)).mode&0o777,0o600);
    await assert.rejects(startServer(home,factory),{code:'DAEMON_ALREADY_RUNNING'});assert.equal(factories,1);
    await assert.rejects(recoverDaemonLock(home),{code:'DAEMON_STILL_RUNNING'});
    const status=await request(home,command('daemon.status'));assert.equal(typeof status,'object');
  }finally{await server.close();}
  assert.equal(closed,1);await assert.rejects(lstat(join(home,'daemon.lock')),{code:'ENOENT'});
});
test('worker nonce、actor偽装、duplicate key、unknown envelope、不正UTF8を拒否する',async()=>{
  const {home,token}=await homeFixture();let dispatches=0;
  const server=await startServer(home,()=>({async dispatch(){dispatches++;return {};},async reconcile(){},close(){}}));
  const hello=JSON.stringify({schemaVersion:1,method:'hello',token})+'\n';
  try {
    const worker=await raw(server.socketPath,[JSON.stringify({schemaVersion:1,method:'hello',nonce:'worker-nonce'})+'\n'],1);assert.equal((worker[0] as {error:{code:string}}).error.code,'PERMISSION_DENIED');
    const duplicate=await raw(server.socketPath,[hello,'{"schemaVersion":1,"requestId":"a","method":"task.get","method":"approval.grant","expectedVersion":null,"params":{}}\n']);assert.equal((duplicate[1] as {error:{code:string}}).error.code,'DUPLICATE_JSON_KEY');
    const unknown=await raw(server.socketPath,[hello,JSON.stringify({...command(),actor:'human'})+'\n']);assert.equal((unknown[1] as {error:{code:string}}).error.code,'INVALID_INPUT');
    const invalid=await raw(server.socketPath,[hello,Buffer.from([0xff,10])]);assert.equal((invalid[1] as {error:{code:string}}).error.code,'INVALID_UTF8');
    const oversized=await raw(server.socketPath,[hello,Buffer.from('x'.repeat(8*1024*1024+1)+'\n')]);assert.equal((oversized[1] as {error:{code:string}}).error.code,'FRAME_TOO_LARGE');
    await assert.rejects(request(home,command('task.get',null,{actorId:'admin'})),{code:'PERMISSION_DENIED'});
    assert.equal(dispatches,0);
  }finally{await server.close();}
});
test('更新versionとcreate nullをenvelope段階で検査する',()=>{
  assert.throws(()=>validateRequest(command('task.start')),{code:'EXPECTED_VERSION_REQUIRED'});
  assert.equal(validateRequest(command('task.start',2)).expectedVersion,2);
  assert.throws(()=>validateRequest(command('task.create',1)),{code:'INVALID_INPUT'});
  assert.equal(validateRequest(command('task.create')).expectedVersion,null);
});
test('private permissionを失ったtokenでは接続しない',async()=>{
  const {home}=await homeFixture();const server=await startServer(home,()=>({async dispatch(){return {};},async reconcile(){},close(){}}));
  try{await chmod(join(home,'control-token'),0o644);await assert.rejects(request(home,command()),{code:'UNSAFE_CONTROL_PATH'});}finally{await server.close();}
});
test('bounded subscriber queueでslow consumerを切断する',async()=>{
  const {home,token}=await homeFixture();
  const server=await startServer(home,()=>({async dispatch(){return {};},async reconcile(){},close(){},events(){return [{seq:1,payload:'x'.repeat(1024*1024)}];}}));
  try {
    const lines=await raw(server.socketPath,[JSON.stringify({schemaVersion:1,method:'hello',token})+'\n',JSON.stringify(command('events.subscribe',null,{afterSeq:0}))+'\n'],3);
    assert.equal((lines[2] as {error:{code:string}}).error.code,'SLOW_CONSUMER');
  }finally{await server.close();}
});
test('daemon stopはserviceを閉じ、worker停止commandをdispatchしない',async()=>{
  const {home}=await homeFixture();let dispatches=0,closed=false;
  const server=await startServer(home,()=>({async dispatch(){dispatches++;return {};},async reconcile(){},close(){closed=true;}}));
  assert.deepEqual(await request(home,command('daemon.stop')),{stopping:true});
  await new Promise<void>(resolve=>setTimeout(resolve,50));await server.close();assert.equal(dispatches,0);assert.equal(closed,true);
});
test('PIDが再利用されstart identityが変わった古いlockだけを明示回収する',async()=>{
  const {home}=await homeFixture(),lock=await acquireDaemonLock(home);
  await writeFile(join(home,'daemon.lock','owner.json'),JSON.stringify({...lock.owner,startIdentity:'previous-boot:previous-start'}),{mode:0o600});
  await recoverDaemonLock(home);await assert.rejects(lstat(join(home,'daemon.lock')),{code:'ENOENT'});
});
test('長いhomeでは利用者専用の短いruntime pathを使う',async()=>{
  const fixture=await homeFixture(),home=join(fixture.home,'long-'.repeat(30));await mkdir(home,{mode:0o700});await writeFile(join(home,'control-token'),fixture.token,{mode:0o600});
  const server=await startServer(home,()=>({async dispatch(){return {};},async reconcile(){},close(){}}));
  try{assert.ok(Buffer.byteLength(server.socketPath)<95);assert.deepEqual(await request(home,command()),{});}finally{await server.close();}
});
test('定期reconciliationのasync呼出を重複させない',async()=>{
  const {home}=await homeFixture();let calls=0,active=0,maximum=0,begin!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{begin=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const server=await startServer(home,()=>({async dispatch(){return {};},async reconcile(){calls++;active++;maximum=Math.max(maximum,active);if(calls===2){begin();await held;}active--;},close(){}}));
  try{await started;await new Promise<void>(resolve=>setTimeout(resolve,600));assert.equal(maximum,1);assert.equal(calls,2);}finally{release();await server.close();}
});
