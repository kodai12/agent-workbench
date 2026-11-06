import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,lstat,writeFile,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {parseCli,runCli} from '../../src/cli/main.js';
import {startServer} from '../../src/daemon/server.js';
import type {CommandRequest} from '../../src/application/types.js';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../../src/cli/main.js',import.meta.url));
async function run(home:string,args:string[]){const output=await exec(process.execPath,[cli,'--home',home,'--json',...args],{timeout:15_000,maxBuffer:1024*1024});return JSON.parse(output.stdout) as {ok:boolean;data:Record<string,unknown>};}
test('CLIのglobal optionを検証し、不正値と重複を拒否する',()=>{
  assert.throws(()=>parseCli(['--timeout-ms','0','daemon','status']),{code:'INVALID_INPUT'});
  assert.throws(()=>parseCli(['--expected-version','1.5','task','start','task']),{code:'INVALID_INPUT'});
  assert.throws(()=>parseCli(['--request-id','not-uuid','repo','list']),{code:'INVALID_INPUT'});
  assert.throws(()=>parseCli(['--home','a','--home','b','repo','list']),{code:'INVALID_INPUT'});
  assert.throws(()=>parseCli(['--unknown','repo','list']));
  assert.equal(parseCli(['--expected-version','null','task','create']).values['expected-version'],'null');
});
test('init fixture/offline doctorはCLIからDBを開かず、daemonをready確認して開始する',async()=>{
  const home=join(await realpath(await mkdtemp(join(tmpdir(),'aw-cli-'))),'home');
  const initialized=await run(home,['init','--dev-fixtures']);assert.equal(initialized.ok,true);assert.equal(initialized.data.home,home);
  await assert.rejects(lstat(join(home,'db','state.sqlite')),{code:'ENOENT'});
  const doctor=await run(home,['doctor','--offline']);assert.equal(doctor.data.offline,true);assert.equal(doctor.data.liveProviderChecks,'未実施');
  await assert.rejects(lstat(join(home,'db','state.sqlite')),{code:'ENOENT'});
  let started=false;const backup=join(home,'backups','integration-backup'),restored=home+'-restored';
  try {
    const daemon=await run(home,['daemon','start','--timeout-ms','5000']);assert.equal(daemon.ok,true);started=true;
    const status=await run(home,['daemon','status']);assert.equal(typeof status.data.pid,'number');
    const again=await run(home,['daemon','start']);assert.equal(again.data.alreadyRunning,true);
    const added=await run(home,['repo','add',String(initialized.data.fixture),'--name','fixture','--base-ref','refs/heads/main']);assert.equal(added.ok,true);
    const listed=await run(home,['repo','list']);assert.ok(Array.isArray(listed.data));assert.equal(listed.data.length,1);
    await run(home,['backup','--destination',backup]);
    await assert.rejects(run(home,['backup','restore','--source',backup,'--destination',restored]));
  }finally{if(started)await run(home,['daemon','stop']);}
  const recovered=await run(home,['backup','restore','--source',backup,'--destination',restored]);assert.equal(recovered.data.reauthenticationRequired,true);assert.equal(recovered.data.unconsumedApprovals,'revoked');
  assert.match(await readFile(join(restored,'control-token'),'utf8'),/^[a-f0-9]{64}$/);assert.notEqual(await readFile(join(restored,'control-token'),'utf8'),await readFile(join(home,'control-token'),'utf8'));
  assert.equal((await lstat(join(restored,'control-token'))).mode&0o777,0o600);
});
test('CLIはversion queryと同requestIdをRPCへ渡し、非TTYのhuman承認を拒否する',async()=>{
  const home=await mkdtemp(join(tmpdir(),'aw-cli-rpc-'));await chmod(home,0o700);await writeFile(join(home,'control-token'),randomBytes(32).toString('hex'),{mode:0o600});
  const calls:CommandRequest[]=[];
  const server=await startServer(home,()=>({async dispatch(request:CommandRequest){calls.push(request);if(request.method==='task.get')return {id:'task',version:7};if(request.method==='repo.get')return {id:'repo',version:3,policy_digest:'sha256:policy',policy:{schemaVersion:1,checks:[]}};return {method:request.method,version:request.expectedVersion};},async reconcile(){},close(){}}));
  try {
    const result=await runCli(['--home',home,'--request-id','req_'+ 'a'.repeat(32),'task','start','task']);assert.deepEqual(result,{method:'task.start',version:7});
    await runCli(['--home',home,'task','recover','task']);assert.deepEqual(calls.find(call=>call.method==='task.recover')?.params,{taskId:'task'});
    const submitted=calls.find(call=>call.method==='task.start');assert.equal(submitted?.requestId,'req_'+'a'.repeat(32));assert.deepEqual(submitted?.params,{taskId:'task',interaction:'managed',presentation:'none'});
    await assert.rejects(runCli(['--home',home,'policy','trust','repo']),{code:'HUMAN_CONFIRMATION_REQUIRED'});assert.equal(calls.some(call=>call.method==='policy.trust'),false);
  }finally{await server.close();}
});
