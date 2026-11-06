import type { Actor,ApprovalBinding,CheckResult,Digest,GateDecision,Json,Result } from '../../contracts/ports.js';
import { validateContract } from '../contracts/loader.js';
import { canonical,digest } from './canonical.js';
import { fail,ok } from './errors.js';
import { array,object,validateDisposition,type FindingDisposition } from './review.js';
export type GateReview={id:string;profileId:string;trainingFamily:string;candidateIdentityDigest:Digest;artifactDigest:Digest;output:Json;valid:boolean;fresh:boolean;readOnly:boolean;simulated:boolean;execution:number};
export type GateInput={candidateIdentity:Json;candidateIdentityDigest:Digest;currentIdentity:Json;requiredCheckIds:string[];checks:CheckResult[];reviews:GateReview[];requiredReviewerProfiles:string[];minimumReviewers:number;minimumTrainingFamilies:number;changedPaths:string[];requirementIds:string[];dispositions:FindingDisposition[];authorId:string;risk:string;allowedRiskSeverities:string[];blockSeverities?:readonly string[];artifacts:ReadonlySet<string>;activeWriter:boolean;pendingPermission:boolean;budgetValid:boolean;protocolValid:boolean;fixtureMode:boolean};
export function evaluateGate(input:GateInput):GateDecision {
 const blockingReasons:GateDecision['blockingReasons']=[];
 const block=(code:string,reference:string|null,message:string)=>blockingReasons.push({code,reference,message});
 const identity=validateContract('candidate-identity',input.candidateIdentity);
 if(!identity.ok || digest(input.candidateIdentity)!==input.candidateIdentityDigest || canonical(input.candidateIdentity)!==canonical(input.currentIdentity)) block('CANDIDATE_CHANGED',null,'候補のidentityが一致しません');
 if(input.activeWriter)block('ACTIVE_WRITER',null,'実行中のwriterがあります');
 if(input.pendingPermission)block('PENDING_PERMISSION',null,'未決の権限要求があります');
 if(!input.budgetValid)block('BUDGET_EXCEEDED',null,'予算条件を満たしません');
 if(!input.protocolValid)block('PROTOCOL_UNCERTAIN',null,'実行状態が不確実です');
 for(const id of input.requiredCheckIds) {
  const checks=input.checks.filter(c=>c.checkId===id);
  if(checks.length!==1) {block('CHECK_MISSING_OR_AMBIGUOUS',id,'必須checkの有効な実行を一件に確定できません');continue;}
  const check=checks[0];if(!check)continue;
  if(check.candidateIdentityDigest!==input.candidateIdentityDigest || check.exitCode!==0 || check.signal!==null || check.timedOut || !check.sourceUnchanged || (!input.fixtureMode && (!check.isolationVerified || check.simulated)))block('CHECK_FAILED',id,'checkが候補上で成功していません');
  for(const a of [check.output,...check.outputs]) if(!input.artifacts.has(a.digest))block('EVIDENCE_MISSING',a.digest,'check証拠がありません');
 }
 const effective:GateReview[]=[];
 for(const profileId of new Set(input.reviews.map(r=>r.profileId))) {
  const attempts=input.reviews.filter(r=>r.profileId===profileId).sort((a,b)=>b.execution-a.execution);
  const review=attempts[0];if(!review)continue;
  if(attempts[1]?.execution===review.execution){block('REVIEW_AMBIGUOUS',profileId,'レビュー実行版が重複しています');continue;}
  const schema=validateContract('review-output',review.output);
  if(!schema.ok || !review.valid || !review.fresh || !review.readOnly || review.candidateIdentityDigest!==input.candidateIdentityDigest || (!input.fixtureMode && review.simulated) || !input.artifacts.has(review.artifactDigest)) {block('REVIEW_INVALID',review.id,'独立レビューまたは証拠が不正です');continue;}
  const output=object(schema.value);
  if(output.verdict==='insufficient_evidence')block('INSUFFICIENT_EVIDENCE',review.id,'補足レビューが必要です');
  const coverage=array(output.coverage).map(object),requirements=array(output.requirementCoverage).map(object);
  if(input.changedPaths.some(path=>!coverage.some(c=>c.path===path&&c.status==='complete')) || input.requirementIds.some(id=>!requirements.some(c=>c.requirementId===id&&c.status==='supported')))block('INCOMPLETE_COVERAGE',review.id,'レビューの確認範囲が不足しています');
  for(const finding of array(output.findings).map(object)) {
   const findingId=review.id+':'+String(finding.key);
   const dispositions=input.dispositions.filter(d=>d.findingId===findingId).sort((a,b)=>b.version-a.version);
   const disposition=dispositions[0];
   const disposed=disposition!==undefined && dispositions[1]?.version!==disposition.version && validateDisposition(disposition,input.authorId,String(finding.severity),input.allowedRiskSeverities).ok && (disposition.state==='false_positive'||disposition.state==='risk_accepted');
   if((new Set(['blocker','high',...(input.blockSeverities??[])]).has(String(finding.severity))||output.verdict==='request_changes')&&!disposed)block('FINDING_UNRESOLVED',findingId,'指摘の処置が必要です');
  }
  if(output.verdict==='request_changes'&&array(output.findings).length===0)block('REVIEW_REQUEST_CHANGES',review.id,'変更要求を補足レビューで解消してください');
  effective.push(review);
 }
 if(effective.length<Math.max(input.minimumReviewers,input.risk==='low'?1:2))block('REVIEW_COUNT',null,'レビュー件数が不足しています');
 if(new Set(effective.map(r=>r.trainingFamily)).size<Math.max(input.minimumTrainingFamilies,input.risk==='high'?2:1))block('REVIEW_FAMILIES',null,'学習系列の数が不足しています');
 for(const profile of input.requiredReviewerProfiles)if(!effective.some(r=>r.profileId===profile))block('REVIEW_PROFILE_MISSING',profile,'必須レビューがありません');
 const sorted=<T>(values:readonly T[],key:(v:T)=>string):T[]=>[...values].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
 const evidenceDigest=digest({gateRuleVersion:1,risk:input.risk,checks:sorted(input.checks,c=>c.checkId+':'+c.attemptId),reviews:sorted(input.reviews,r=>r.id),dispositions:sorted(input.dispositions,d=>d.findingId+':'+String(d.version).padStart(12,'0'))});
 blockingReasons.sort((a,b)=>(a.code+':'+a.reference).localeCompare(b.code+':'+b.reference));
 return {passed:blockingReasons.length===0,candidateIdentityDigest:input.candidateIdentityDigest,evidenceDigest,blockingReasons};
}
export type ApprovalContext={actor:Actor;bindingDigest:Digest;expected:ApprovalBinding;nowMs:number;usedNonces:ReadonlySet<string>;revoked:boolean;gate:GateDecision};
export function validateApproval(binding:ApprovalBinding,context:ApprovalContext):Result<void> {
 const valid=validateContract('approval-binding',binding);if(!valid.ok)return valid;
 if(context.actor.kind!=='human')return fail('PERMISSION_DENIED','人間の接続からの承認が必要です');
 if(context.revoked || context.usedNonces.has(binding.nonce) || context.nowMs>=binding.expiresAtMs)return fail('APPROVAL_EXPIRED','承認は失効済みか使用済みです');
 if(digest(binding)!==context.bindingDigest || canonical(binding)!==canonical(context.expected) || !context.gate.passed || context.gate.candidateIdentityDigest!==binding.candidateIdentityDigest || context.gate.evidenceDigest!==binding.evidenceDigest)return fail('APPROVAL_BINDING_MISMATCH','承認対象と最新の候補証拠が一致しません');
 return ok(undefined);
}
