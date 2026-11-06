import type {CheckRequest,CheckResult,CheckRunner,Result} from '../../../contracts/ports.js';
import type {CommandExecParams} from '../../generated/codex/v2/CommandExecParams.js';
import {fail} from '../../domain/errors.js';
export function buildCommandExecParams(request:CheckRequest):CommandExecParams {
 return {command:request.argv,cwd:request.cwd,env:request.environment,timeoutMs:request.timeoutMs,outputBytesCap:request.maxOutputBytes,sandboxPolicy:{type:'workspaceWrite',writableRoots:[request.cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}} satisfies CommandExecParams;
}
export class CodexCheckRunner implements CheckRunner {
 async execute(_request:CheckRequest,_signal:AbortSignal):Promise<Result<CheckResult>> {
  return fail('SANDBOX_UNVERIFIED','捕捉したSandboxPolicyではrestricted readを設定できず、check用canaryも未検証です');
 }
}
