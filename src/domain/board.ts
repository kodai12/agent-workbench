import type { Digest,Json,Result } from '../../contracts/ports.js';
import { parseJson,validateContract } from '../contracts/loader.js';
import { bytesDigest,digest } from './canonical.js';
import { fail,ok } from './errors.js';
import { object,array } from './review.js';
export type BoardSeat={id:string;trainingFamily:string;active:boolean};
export type BoardPost={seatId:string;attemptId:string;epoch:number;digest:Digest;output:Json;rawOutput?:string};
export type BoardRound={round:number;epoch:number;state:'collecting'|'sealed'|'aborted';seats:BoardSeat[];posts:BoardPost[];minimumTrainingFamilies:number;minimumSeats:number};
export function sealPost(round:BoardRound,post:BoardPost,publishedItems:ReadonlySet<string>,turnCompleted:boolean):Result<BoardRound> {
 if(round.state!=='collecting'||post.epoch!==round.epoch)return fail('STALE_BOARD_EPOCH','現在の募集roundではありません');
 if(!turnCompleted||!round.seats.some(s=>s.active&&s.id===post.seatId))return fail('INVALID_BOARD_SEAT','有効な席の完了出力が必要です');
 const valid=validateContract('board-post',post.output);if(!valid.ok)return valid;
 let expectedDigest:Digest;
 if(post.rawOutput!==undefined){const parsed=parseJson(post.rawOutput);if(!parsed.ok||JSON.stringify(parsed.value)!==JSON.stringify(valid.value))return fail('RAW_OUTPUT_MISMATCH','元出力と投稿内容が一致しません');expectedDigest=bytesDigest(post.rawOutput);}
 else {try{expectedDigest=digest(valid.value);}catch{return fail('RAW_OUTPUT_REQUIRED','小数を含む投稿は元のJSON本文とbytes digestが必要です');}}
 if(expectedDigest!==post.digest)return fail('DIGEST_MISMATCH','投稿のdigestが一致しません');
 const prior=round.posts.find(p=>p.seatId===post.seatId);
 if(prior)return prior.digest===post.digest?ok(round):fail('POST_ALREADY_ACCEPTED','投稿は上書きできません');
 const output=object(valid.value),items=array(output.items).map(object),ids=items.map(i=>i.id);
 if(ids.some(id=>typeof id!=='string'||!id.startsWith(post.seatId+':'))||new Set(ids).size!==ids.length)return fail('INVALID_BOARD_ITEM','item IDは席固有で重複しない値が必要です');
 const visible=new Set([...publishedItems,...ids.filter((v):v is string=>typeof v==='string')]);
 for(const item of items) {
  if(item.forkedFrom!==null && !publishedItems.has(String(item.forkedFrom)))return fail('BLIND_REFERENCE','未公開の案への参照です');
  if(item.estimate!==null) {const e=object(item.estimate);if(typeof e.lower!=='number'||typeof e.value!=='number'||typeof e.upper!=='number'||e.lower>e.value||e.value>e.upper)return fail('INVALID_ESTIMATE','推計の上下限が逆転しています');}
 }
 for(const objection of array(output.objections).map(object))if(!publishedItems.has(String(objection.targetItem)))return fail('BLIND_REFERENCE','未公開の案への反論です');
 const position=object(output.position);
 for(const id of [position.champion,...array(position.coPicks)])if(id!==null&&!visible.has(String(id)))return fail('UNKNOWN_BOARD_ITEM','選択した案が存在しません');
 return ok({...round,posts:[...round.posts,post]});
}
export function closeBarrier(round:BoardRound):Result<BoardRound> {
 if(round.state!=='collecting')return fail('INVALID_BOARD_PHASE','募集段階ではありません');
 const seats=round.seats.filter(s=>s.active);
 if(seats.length<round.minimumSeats||new Set(seats.map(s=>s.trainingFamily)).size<round.minimumTrainingFamilies)return fail('INSUFFICIENT_SEATS','席数または学習系列が不足しています');
 if(seats.some(s=>!round.posts.some(p=>p.seatId===s.id&&p.epoch===round.epoch)))return fail('BOARD_BARRIER_PENDING','全席の提出が揃っていません');
 return ok({...round,state:'sealed'});
}
export function buildSeatPacket(roundNumber:number,seatId:string,rounds:readonly BoardRound[]):Json {
 return {round:roundNumber,seatId,posts:rounds.filter(r=>r.state==='sealed'&&r.round<roundNumber).sort((a,b)=>a.round-b.round).flatMap(r=>[...r.posts].sort((a,b)=>a.seatId.localeCompare(b.seatId)).map(p=>({round:r.round,seatId:p.seatId,digest:p.digest,output:p.output})))};
}
export type MemoItem={id:string;author:string;pitch:string;premises:string[];withdrawn:boolean;verifiedFatal:boolean;responseOpportunity:boolean};
export type Memo={terminationReason:'converged'|'round_limit'|'budget_limit'|'insufficient_seats'|'cancelled';finalists:{itemId:string;pitch:string;conditionalTags:string[];audits:{premise:string;seatId:string;verified:boolean}[]}[];rejected:{itemId:string;reason:string}[];unresolvedDissent:string[];openCruxes:string[];limitations:string[]};
export function validateMemo(memo:Memo,items:readonly MemoItem[],dissent:readonly string[]):Result<Memo> {
 const referenced=[...memo.finalists.map(x=>x.itemId),...memo.rejected.map(x=>x.itemId)];
 if(new Set(referenced).size!==referenced.length || items.some(i=>!referenced.includes(i.id)) || referenced.some(id=>!items.some(i=>i.id===id)))return fail('BOARD_CANDIDATE_LOST','全ての案を保持してください');
 for(const rejected of memo.rejected) {const item=items.find(i=>i.id===rejected.itemId);if(!item||!rejected.reason.trim()||(!item.withdrawn&&!(item.verifiedFatal&&item.responseOpportunity)))return fail('UNSUPPORTED_REJECTION','多数決だけで案を排除できません');}
 for(const f of memo.finalists) {
  const item=items.find(i=>i.id===f.itemId);if(!item||item.pitch!==f.pitch)return fail('INVALID_MEMO_QUOTE','案の原文が一致しません');
  const missing=item.premises.some(p=>!f.audits.some(a=>a.premise===p&&a.seatId!==item.author&&a.verified));
  if(missing&&!f.conditionalTags.includes('premise_audit_missing'))return fail('PREMISE_AUDIT_REQUIRED','前提未確認の条件タグが必要です');
 }
 if(dissent.some(d=>!memo.unresolvedDissent.includes(d)))return fail('DISSENT_LOST','少数意見を保持してください');
 if(memo.terminationReason!=='converged'&&(memo.limitations.length===0 || (memo.terminationReason==='round_limit'&&memo.openCruxes.length===0)))return fail('INCOMPLETE_MEMO','停止理由と未解決論点を保持してください');
 return ok(memo);
}
