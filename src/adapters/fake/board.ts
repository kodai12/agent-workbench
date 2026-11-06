import type {Json} from '../../../contracts/ports.js';
import {object,array as list} from '../../domain/review.js';
const text=(value:Json|undefined):string=>{if(typeof value!=='string')throw new Error('文字列が必要です');return value;};

export function fakeBoardPost(seatId:string,round:number,shape:string,packet:Json,auditing=false):Json {
 const posts=list(object(packet).posts??[]).map(object);
 const previousItems=posts.flatMap(p=>list(object(p.output).items).map(object));
 const initialCount=shape==='ideas'?6:3;
 const items:Json[]=round===0?Array.from({length:initialCount},(_,i)=>({id:`${seatId}:option-${i+1}`,title:i===0?'現状維持':`fixture案${i+1}`,proposal:i===0?'既存のfixtureを維持する':`既知fixtureの検証条件${i+1}を追加する`,decisivePremises:['既知fixtureの入出力を確認できる'],failureModes:['実環境への適合は未検証'],evidence:[],forkedFrom:null,estimate:shape==='estimate'?{value:i+1,lower:i,upper:i+2,unit:'fixture検査回数',assumptions:['fixture内だけの例示']} :null})):[];
 const own=round===0?object(items[0]):previousItems.find(i=>text(i.id).startsWith(seatId+':'));
 const others=previousItems.filter(i=>!text(i.id).startsWith(seatId+':'));
 return {schemaVersion:1,items,objections:round>0&&!auditing?others.map(i=>({targetItem:text(i.id),claim:'実環境への適合を示す証拠は未確認',evidence:[],classification:'question'})):[],concessions:[],premiseAudits:auditing?others.flatMap(i=>list(i.decisivePremises).map(p=>({itemId:text(i.id),premise:text(p),status:'unverified',whatEstablished:'fixtureの構造化出力だけを確認',whatNotEstablished:'実データと実環境での前提成立は未確認',evidence:[]}))):[],position:{champion:own?text(own.id):null,coPicks:[],dropCondition:'fixture外の証拠が必要になった場合',changeReason:round>0?'新たな実証結果がないため原案を保持':null,deadItems:[],openCruxes:['実環境での前提成立は未検証'],pitch:'fixtureでの検討例。意思決定は人間が行う'}};
}
