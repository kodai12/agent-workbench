import type { Digest,Json,Result } from '../../contracts/ports.js';
import { validateContract } from '../contracts/loader.js';
import { fail } from './errors.js';
import { array,object,validateEvidence,type SourceEvidence } from './review.js';
export type HandoffContext={taskId:string;sourceAttemptId:string;sourceEventCutoff:number;sourceQuiescent:boolean;candidateIdentityDigest:Digest|null;nativeHistoryAvailable:boolean;sources:Readonly<Record<string,SourceEvidence>>};
export function validateCitations(output:unknown,context:HandoffContext):Result<Json> {
 const checked=validateContract('handoff',output);if(!checked.ok)return checked;
 const handoff=object(checked.value);
 if(!context.sourceQuiescent || handoff.taskId!==context.taskId || handoff.sourceAttemptId!==context.sourceAttemptId || handoff.sourceEventCutoff!==context.sourceEventCutoff || handoff.candidateIdentityDigest!==context.candidateIdentityDigest)return fail('HANDOFF_SOURCE_MISMATCH','停止済みの引き継ぎ元とcutoffを固定してください');
 for(const group of ['facts','decisions'])for(const row of array(handoff[group]).map(object))for(const e of array(row.evidence)) {const valid=validateEvidence(e,context);if(!valid.ok)return valid;}
 for(const ref of array(handoff.sourceRefs))if(typeof ref!=='string'||!Object.values(context.sources).some(s=>s.digest===ref))return fail('INVALID_EVIDENCE','引き継ぎ元artifactが存在しません');
 if(!context.nativeHistoryAvailable && !array(handoff.nonGoals).some(v=>typeof v==='string'&&v.includes('native')))return fail('NATIVE_HISTORY_UNAVAILABLE','native会話未取込を明記してください');
 return checked;
}
