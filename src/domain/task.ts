import type { Result } from '../../contracts/ports.js';
import { contracts } from '../contracts/loader.js';
import { fail, ok } from './errors.js';
export type TaskFacts = Readonly<Record<string,boolean|undefined>>;
export const taskGuards:Readonly<Record<string,readonly string[]>>={
 TASK_SUBMITTED:['specValid','policyTrusted','profilesResolved'],
 START_REQUESTED:['dependenciesComplete','dependencyShasFixed','noActiveRun','budgetAvailable'],
 WORKER_READY:['checkoutMatches','leaseMatches','workerMatches','sandboxVerified'],
 INPUT_REQUIRED:['activeAttemptMatches','requestClassified'], HUMAN_REPLY:['requestMatches','turnMatches','requestUnexpired'],
 IMPLEMENTATION_RETURNED:['executionCompleted','outputValid','completionDeclared'],
 NATIVE_FINISH_REQUESTED:['humanRequested','writerQuiescent','childrenQuiescent'],
 CANDIDATE_FROZEN:['writerQuiescent','scopeValid','snapshotPersisted','manifestPersisted'],
 CHECKS_PASSED:['checksPassed','sameCandidate','outputsPresent','sourceUnchanged'],
 CHECKS_FAILED:['checkFailureObserved'],REVIEWS_PASSED:['reviewGatePassed','familiesSufficient','coverageComplete','findingsDisposed'],
 REVIEWS_FAILED:['reviewFailureObserved'],INTEGRATION_AUTHORIZED:['approvalValid','bindingMatches','baseMatches','noActiveWriter'],
 INTEGRATION_CONFIRMED:['refMatchesCandidate','journalConfirmed'],CANDIDATE_INVALIDATED:['approvalRevoked','invalidationObserved'],
 BASE_MOVED:['casFailed'],REVISION_REQUESTED:['revisionAuthorized','generationIncreased'],
 RETRY_AUTHORIZED:['oldWriterQuiescent','causeRecorded','retryRecorded'],EXECUTION_UNCERTAIN:['uncertaintyObserved'],
 EXECUTION_FAILED:['failureObserved'],RECOVERY_RETRY_AUTHORIZED:['oldWriterQuiescent','workspacePreserved','generationIncreased'],
 CANCEL_CONFIRMED:['noActiveWriter','historyPreserved'],CANCEL_QUIESCENT:['noActiveWriter','historyPreserved']
};
export type Transition = {from:string;event:string;to:string};
function transitions():Transition[] {
 const state=contracts.get('state-machine.json');
 if(!state || typeof state!=='object' || Array.isArray(state) || !Array.isArray(state.transitions)) throw new Error('INVALID_STATE_MACHINE');
 return state.transitions.map(row=>{
  if(!row || typeof row!=='object' || Array.isArray(row) || typeof row.from!=='string' || typeof row.event!=='string' || typeof row.to!=='string') throw new Error('INVALID_STATE_MACHINE');
  return {from:row.from,event:row.event,to:row.to};
 });
}
export const taskTransitions=transitions();
export function reduceTask(state:string,event:string,facts:TaskFacts):Result<string> {
 const row=taskTransitions.find(t=>t.from===state && t.event===event);
 if(!row) return fail('INVALID_TRANSITION','許可されていない状態遷移です',{state,event});
 const guards=taskGuards[event];
 if(!guards) return fail('INVALID_TRANSITION','遷移ガードがありません',{event});
 const fixtureSandbox=event==='WORKER_READY' && facts.fixtureMode===true && facts.knownFixture===true && facts.simulated===true;
 const missing=guards.filter(name=>facts[name]!==true && !(name==='sandboxVerified' && fixtureSandbox));
 return missing.length?fail('TRANSITION_GUARD_FAILED','状態遷移の条件を満たしません',{state,event,missing}):ok(row.to);
}
