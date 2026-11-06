import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectProtocolLock} from '../../src/application/protocol.js';
import {object} from '../../src/application/data.js';
test('全capture fileをlockと照合しlive検証と区別する',()=>{const result=object(inspectProtocolLock());assert.equal(result.locked,true);assert.equal(result.liveVerified,false);assert.equal(result.strictSandboxVerified,false);assert.ok(Number(result.files)>0);});
