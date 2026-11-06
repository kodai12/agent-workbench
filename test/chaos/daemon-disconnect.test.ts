import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startServer} from '../../src/daemon/server.js';
import {request} from '../../src/daemon/client.js';
test('処理中切断でclient pendingが失敗し、serverは処理完了までcloseを待つ',async()=>{
  const home=await mkdtemp(join(tmpdir(),'aw-daemon-cut-'));await chmod(home,0o700);await writeFile(join(home,'control-token'),randomBytes(32).toString('hex'),{mode:0o600});
  let begin!:()=>void,complete!:()=>void;
  const started=new Promise<void>(resolve=>{begin=resolve;}),done=new Promise<void>(resolve=>{complete=resolve;});
  const server=await startServer(home,()=>({async dispatch(){begin();await done;return {};},async reconcile(){},close(){}}));
  const response=request(home,{schemaVersion:1,requestId:'disconnect',method:'task.get',expectedVersion:null,params:{}});
  const rejected=assert.rejects(response,{code:'CONNECTION_CLOSED'});await started;
  const closing=server.close();await rejected;complete();await closing;
});
