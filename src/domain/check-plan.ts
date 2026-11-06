import type {Json,Result} from '../../contracts/ports.js';
import {validateContract} from '../contracts/loader.js';
import {array,object} from './review.js';
import {asError,fail,ok} from './errors.js';
import {matchPattern,validateRelativePath} from './paths.js';
export function buildCheckPlan(specInput:unknown,policyInput:unknown,changedPaths:readonly string[]):Result<Json> {
 const specValid=validateContract('task-spec',specInput);if(!specValid.ok)return specValid;
 const policyValid=validateContract('project-policy',policyInput);if(!policyValid.ok)return policyValid;
 try {
  const spec=object(specValid.value),policy=object(policyValid.value),scope=object(spec.scope),review=object(policy.review),budget=object(spec.budget);
  const strings=(v:Json|undefined):string[]=>array(v).map(x=>{if(typeof x!=='string')throw new Error('EXPECTED_STRING');return x;});
  const requirements=array(spec.requirements).map(object),checks=array(policy.checks).map(object),rules=array(policy.riskRules).map(object);
  const groups=[requirements.map(r=>r.id),checks.map(c=>c.id),strings(spec.checkIds),strings(spec.reviewerProfiles),strings(spec.dependsOn),changedPaths];
  if(groups.some(values=>new Set(values).size!==values.length))return fail('DUPLICATE_REFERENCE','要求、check、profile、依存または変更pathが重複しています');
  if(strings(spec.dependsOn).some(id=>!/^tsk_[0-9a-f]{32}$/.test(id)))return fail('INVALID_ID_PREFIX','依存先はtask IDが必要です');
  if(typeof budget.maxAttempts!=='number'||typeof budget.maxRepairCycles!=='number'||budget.maxRepairCycles>=budget.maxAttempts)return fail('INVALID_BUDGET','修正cycleは総attempt予算を超えられません');
  const allow=strings(scope.allowedPaths),deny=strings(scope.forbiddenPaths);
  for(const pattern of [...allow,...deny,...rules.flatMap(r=>strings(r.paths))])matchPattern('validation-placeholder',pattern);
  for(const path of [...changedPaths,...strings(spec.contextFiles)]) {const valid=validateRelativePath(path);if(!valid.ok)return valid;if(deny.some(p=>matchPattern(path,p)))return fail('PATH_OUTSIDE_SCOPE','禁止pathへの参照です',{path});}
  for(const path of changedPaths)if(!allow.some(p=>matchPattern(path,p)))return fail('PATH_OUTSIDE_SCOPE','許可scope外の変更です',{path});
  const available=new Set(checks.map(c=>String(c.id)));
  const declaredRefs=[...strings(spec.checkIds),...requirements.flatMap(r=>strings(r.checkIds)),...rules.flatMap(r=>strings(r.requiredCheckIds))];
  for(const checkId of declaredRefs)if(!available.has(checkId))return fail('UNKNOWN_CHECK','trusted policyに存在しないcheckです',{checkId});
  for(const check of checks) {
   const cwd=String(check.cwd);if(cwd!=='.'){const valid=validateRelativePath(cwd);if(!valid.ok)return valid;}
   for(const path of strings(check.expectedArtifacts)){const valid=validateRelativePath(path);if(!valid.ok)return valid;}
   const hosts=strings(check.allowHosts);if(check.network==='deny'&&hosts.length>0||check.network==='explicit-allowlist'&&hosts.length===0)return fail('INVALID_NETWORK_POLICY','networkと宛先一覧が整合していません');
  }
  const rank:Readonly<Record<string,number>>={low:0,standard:1,high:2};let risk=String(spec.risk);
  let minimumTrainingFamilies=Math.max(Number(review.minimumTrainingFamilies),risk==='high'?2:1);
  const required=new Set([...strings(spec.checkIds),...requirements.flatMap(r=>strings(r.checkIds)),...checks.filter(c=>c.required===true).map(c=>String(c.id))]);
  for(const rule of rules)if(changedPaths.some(path=>strings(rule.paths).some(pattern=>matchPattern(path,pattern)))) {
   if((rank[String(rule.risk)]??0)>(rank[risk]??0))risk=String(rule.risk);
   minimumTrainingFamilies=Math.max(minimumTrainingFamilies,Number(rule.minimumTrainingFamilies));for(const id of strings(rule.requiredCheckIds))required.add(id);
  }
  if(risk==='high')minimumTrainingFamilies=Math.max(minimumTrainingFamilies,2);
  const minimumReviewers=Math.max(Number(review.minimumReviewers),risk==='low'?1:2,minimumTrainingFamilies);
  const requiredCheckIds=[...required].sort();
  return ok({schemaVersion:1,risk,requiredCheckIds,checks:requiredCheckIds.map(id=>checks.find(c=>c.id===id)??null),minimumReviewers,minimumTrainingFamilies,reviewerProfiles:strings(spec.reviewerProfiles),blockSeverities:[...new Set(['blocker','high',...strings(review.blockSeverities)])].sort(),allowIncomplete:false,maxRepairCycles:Math.min(Number(review.maxRepairCycles),Number(budget.maxRepairCycles))});
 }catch(error){return {ok:false,error:asError(error)};}
}
