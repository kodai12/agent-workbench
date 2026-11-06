import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import {parseJson} from '../../src/contracts/loader.js';
test('strict parserは生成JSONを保存し、escaped duplicate keyを拒否する',()=>{
 fc.assert(fc.property(fc.jsonValue(),value=>{const encoded=JSON.stringify(value);const parsed=parseJson(encoded);assert.ok(parsed.ok);assert.deepEqual(parsed.value,JSON.parse(encoded));}),{seed:812472,numRuns:300});
 fc.assert(fc.property(fc.string(),key=>{const k=JSON.stringify(key);assert.equal(parseJson('{'+k+':1,'+k+':2}').ok,false);}),{seed:812473,numRuns:300});
});
