import test from 'node:test';
import assert from 'node:assert/strict';
import {validateContract} from '../../src/contracts/loader.js';
import {asError} from '../../src/domain/errors.js';
test('境界でJSON pointer付きschema違反の詳細を保持する',()=>{const result=validateContract('task-spec',{});assert.equal(result.ok,false);if(!result.ok){const error=asError(result.error);assert.equal(error.code,'SCHEMA_VALIDATION_FAILED');assert.deepEqual(error.details,result.error.details);assert.ok(Array.isArray(error.details.violations));assert.ok(error.details.violations.length>0);}});
