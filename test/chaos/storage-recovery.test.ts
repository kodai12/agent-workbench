import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../src/adapters/sqlite/store.js';
import { recoverSpool } from '../../src/adapters/filesystem/spool.js';
import { unwrap } from '../../src/domain/errors.js';

test('新schemaのDBを古いバイナリで開かない',async()=>{
  const home=await mkdtemp(join(tmpdir(),'aw-schema-')),store=unwrap(openStore(home));
  store.db.prepare("INSERT INTO schema_migrations VALUES(2,'future',1)").run();store.close();
  const result=openStore(home);assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'SCHEMA_TOO_NEW');
});
test('完全行の破損時にはspoolを切り詰めない',async()=>{
  const home=await mkdtemp(join(tmpdir(),'aw-spool-corrupt-')),path=join(home,'events.jsonl');
  await writeFile(path,'not-json\npartial');const result=await recoverSpool(path);assert.equal(result.ok,false);
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(path,'utf8'),'not-json\npartial');
});
