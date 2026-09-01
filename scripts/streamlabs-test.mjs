// Real sequence controller, simulated browser/DB and a virtual clock. Never posts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const url = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
const source = async p => ts.transpileModule(await readFile(new URL(p, import.meta.url), 'utf8'), { compilerOptions: {module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022} }).outputText;
const matcherUrl = url(await source('../lib/automation/streamlabs-matcher.ts'));
const policyUrl = url(await source('../lib/automation/retry-policy.ts'));
const cancelUrl = url(await source('../lib/automation/cancellation.ts'));
const controllerSource = await source('../lib/automation/streamlabs-controller.ts');
const { isHeistAnnouncement, AnnouncementTracker } = await import(matcherUrl);
const announcement = (id='event1', author='Streamlabs', text='Ahoy! Captain Alice is trying to get a crew together for a treasure hunt! Type !heist [amount] to join.')=>({id,author,text});

test('matches varying usernames, spacing and small wording changes from Streamlabs',()=>{
  assert.ok(isHeistAnnouncement(announcement()));
  assert.ok(isHeistAnnouncement(announcement('2','@Streamlabs','AHOY! Captain Bob_123 wants a crew for a treasure hunt. Type !heist 100 to join!')));
  assert.ok(isHeistAnnouncement(announcement('3',' Streamlabs ','Ahoy Captain 👑! Crew together for a treasure\n hunt. Use !heist [amount] to join.')));
});
test('does not match viewer copies, incomplete messages or missing stable IDs',()=>{
  for(const msg of [announcement('1','RandomViewer'),announcement(''),announcement('1','Streamlabs','!heist 100'),announcement('1','Streamlabs','The treasure hunt has ended!')])assert.equal(isHeistAnnouncement(msg),false);
});
test('baselines history; ignores rerender; identical text with NEW ID triggers',()=>{
  const tracker=new AnnouncementTracker();
  assert.deepEqual(tracker.observe([announcement('old')]),[]);
  assert.deepEqual(tracker.observe([announcement('old'),announcement('new')]).map(a=>a.id),['new']);
  assert.deepEqual(tracker.observe([announcement('new')]),[]);
  tracker.resetBaseline();
  assert.deepEqual(tracker.observe([announcement('history-after-reconnect')]),[]);
  assert.equal(tracker.observe([announcement('another-new')]).length,1);
});

let serial=0;
async function fixture(t, count=3) {
 const mockUrl=url(`// isolated ${serial++}
export const state={now:2000000000000,rows:[],logs:[],sends:[],outcomes:[],messages:[],pending:[],pages:[],claims:new Set(),executions:{},settings:{}};
const apply=(row,data)=>{for(const [k,v] of Object.entries(data))row[k]=v&&typeof v==='object'&&'increment' in v?(row[k]??0)+v.increment:v;return row};
export const db={
 automation:{update:async({where,data})=>apply(state.rows.find(r=>r.id===where.id),data)},
 automationExecution:{create:async({data})=>{const id='exec-'+data.automationId;state.executions[id]={...data};return {id}},update:async({where,data})=>apply(state.executions[where.id],data)},
 googleAccount:{findUniqueOrThrow:async({where})=>state.rows.find(r=>r.googleAccountId===where.id).googleAccount,update:async({where,data})=>apply(state.rows.find(r=>r.googleAccountId===where.id).googleAccount,data)},
 appSetting:{upsert:async({update})=>{state.settings=JSON.parse(update.value)}},
 streamlabsTrigger:{create:async({data})=>{const key=data.videoId+'/'+data.messageId;if(state.claims.has(key))throw {code:'P2002'};state.claims.add(key)}}
};
export const browserManager={newPage:async(accountId)=>{const page={accountId,closed:false,address:'',isClosed(){return this.closed},url(){return this.address},async goto(u){this.address=u},async close(){this.closed=true}};state.pages.push(page);return page},closePage:async(accountId,page)=>{assertAccount(accountId,page);await page.close()}};
function assertAccount(id,page){if(id!==page.accountId)throw Error('Account isolation violated')}
export const sendChatMessage=async(page,url,message,signal,options)=>{signal.throwIfAborted();state.sends.push({accountId:page.accountId,url,message,at:state.now,options});const r=state.outcomes.shift();if(r instanceof Error)throw r;return r??{ok:true,status:'SENT'}};
export const detectAccountStatus=async()=>({authenticated:true});
export const detectStreamStatus=async()=>({active:true,ended:false});
export const readStreamlabsChat=async()=>state.messages;
export const activityLog=async(row)=>{state.logs.push(row)};
export const emitDashboardEvent=()=>{};
export const delay=(ms,signal)=>new Promise((resolve,reject)=>{signal.throwIfAborted();const entry={at:state.now+ms,resolve:()=>{signal.removeEventListener('abort',abort);resolve()}};const abort=()=>{state.pending=state.pending.filter(x=>x!==entry);reject(signal.reason)};state.pending.push(entry);signal.addEventListener('abort',abort,{once:true})});
`);
 const mock=await import(mockUrl);
 mock.state.rows=Array.from({length:count},(_,i)=>({id:'auto'+i,name:'Automation '+i,googleAccountId:'account'+i,googleAccount:{id:'account'+i,displayName:'Account '+i,status:'CONNECTED'},videoId:'video'+i,youtubeUrl:'https://www.youtube.com/watch?v=video'+i,message:'message '+i,intervalSeconds:600,maxMessages:1,runUntilStopped:false,messagesSent:0,sessionMessagesSent:0,status:'STOPPED'}));
 let code=controllerSource.replace('from "./streamlabs-matcher"',`from "${matcherUrl}"`).replace('from "./cancellation"',`from "${cancelUrl}"`).replace('from "./retry-policy"',`from "${policyUrl}"`);
 for(const dep of ['@/lib/db/client','@/lib/browser/browser-manager','@/lib/browser/youtube-chat','@/lib/browser/streamlabs-chat','@/lib/logger/activity-logger','@/lib/events'])code=code.replace(`from "${dep}"`,`from "${mockUrl}"`);
 const { StreamlabsController }=await import(url(code));
 const controller=new StreamlabsController(mock.delay);
 const originalNow=Date.now;Date.now=()=>mock.state.now;
 t.after(async()=>{await controller.stop();Date.now=originalNow});
 const tick=async ms=>{mock.state.now+=ms;const due=mock.state.pending.filter(p=>p.at<=mock.state.now);mock.state.pending=mock.state.pending.filter(p=>p.at>mock.state.now);due.forEach(p=>p.resolve());await flush()};
 const enable=async()=>{await controller.start(mock.state.rows);await flush();await tick(2000);assert.equal(controller.snapshot().phase,'LISTENING')};
 return {...mock,controller,tick,enable};
}
async function flush(){for(let i=0;i<40;i++)await new Promise(setImmediate)}

test('one round uses account/message order and full 10-second gaps, then waits',async t=>{
 const f=await fixture(t);f.state.messages=[announcement('old')];await f.enable();assert.equal(f.state.sends.length,0);
 f.state.messages.push(announcement());await f.tick(750);assert.equal(f.state.sends.length,1);
 await f.tick(9999);assert.equal(f.state.sends.length,1);
 await f.tick(1);assert.equal(f.state.sends.length,2);
 await f.tick(10000);assert.equal(f.state.sends.length,3);
 assert.deepEqual(f.state.sends.map(s=>[s.accountId,s.message]),[['account0','message 0'],['account1','message 1'],['account2','message 2']]);
 assert.equal(f.controller.snapshot().phase,'LISTENING');
 await f.tick(120000);assert.equal(f.state.sends.length,3);
 f.state.messages.push(announcement('new-round'));await f.tick(750);await f.tick(10000);await f.tick(10000);
 assert.equal(f.state.sends.length,6);assert.ok(f.state.rows.every(r=>r.messagesSent===2)); // finite session limits suspended
});
test('stop during gap cancels queued sends and closes only owned pages',async t=>{
 const f=await fixture(t);await f.enable();f.state.messages=[announcement()];await f.tick(750);
 await f.controller.stop();await f.tick(120000);
 assert.equal(f.state.sends.length,1);assert.equal(f.controller.snapshot().enabled,false);assert.ok(f.state.pages.every(p=>p.closed));assert.equal(f.state.pending.length,0);
});
test('repeated rows and announcements during a round do not spawn or queue another round',async t=>{
 const f=await fixture(t);await f.enable();f.state.messages=[announcement()];await f.tick(750);
 f.state.messages.push(announcement('overlap'));await f.tick(750);
 await f.tick(10000);await f.tick(10000);await f.tick(120000);
 assert.equal(f.state.sends.length,3);assert.ok(f.state.logs.some(l=>l.action==='STREAMLABS_OVERLAP_SKIPPED'));
});
test('durable claim blocks already-processed message after a new baseline',async t=>{
 const f=await fixture(t,1);f.state.claims.add('video0/event1');await f.enable();f.state.messages=[announcement()];await f.tick(750);assert.equal(f.state.sends.length,0);
});
test('uncertain send is not retried in same round; other account continues',async t=>{
 const f=await fixture(t,2);f.state.outcomes=[{ok:false,status:'ERROR',retryable:true,reason:'Uncertain delivery'}];await f.enable();f.state.messages=[announcement()];await f.tick(750);await f.tick(10000);
 assert.equal(f.state.sends.length,2);assert.equal(f.state.rows[0].messagesSent,0);assert.equal(f.state.rows[1].messagesSent,1);assert.ok(f.state.logs.some(l=>l.action==='STREAMLABS_SEND_DEFERRED'));
 await f.tick(120000);f.state.messages.push(announcement('fresh'));await f.tick(750);assert.equal(f.state.sends.length,3);
});
test('actual rejection blocks that automation but leaves others listening',async t=>{
 const f=await fixture(t,2);f.state.outcomes=[{ok:false,status:'ERROR',reason:'Posting blocked'}];await f.enable();f.state.messages=[announcement()];await f.tick(750);await f.tick(10000);
 assert.equal(f.state.rows[0].status,'ERROR');assert.equal(f.state.rows[1].messagesSent,1);assert.equal(f.controller.snapshot().enabled,true);
 await f.tick(120000);f.state.messages.push(announcement('fresh'));await f.tick(750);assert.equal(f.state.sends.at(-1).accountId,'account1');
});
test('slow mode is respected on later announcements and never resends the old one',async t=>{
 const f=await fixture(t,1);f.state.outcomes=[{ok:false,status:'RATE_LIMITED',retryAfterSeconds:180,reason:'Slow mode'}];await f.enable();f.state.messages=[announcement()];await f.tick(750);
 await f.tick(120000);f.state.messages.push(announcement('too-soon'));await f.tick(750);assert.equal(f.state.sends.length,1);
 await f.tick(60000);f.state.messages.push(announcement('ready'));await f.tick(750);assert.equal(f.state.sends.length,2);
});
test('same-account events do not bypass the account cooldown',async t=>{
 const f=await fixture(t,2);f.state.rows[1].googleAccountId='account0';await f.enable();f.state.messages=[announcement()];await f.tick(750);await f.tick(10000);
 assert.equal(f.state.sends.length,1);assert.ok(f.state.logs.some(l=>l.action==='STREAMLABS_COOLDOWN'));
});
test('mode cannot be started twice',async t=>{const f=await fixture(t,1);await f.enable();await assert.rejects(()=>f.controller.start(f.state.rows),/already running/)});

test('all accounts blocked stops mode with a visible error and closes pages',async t=>{
 const f=await fixture(t,1);f.state.outcomes=[{ok:false,status:'AUTH_REQUIRED',reason:'Sign in required'}];await f.enable();f.state.messages=[announcement()];await f.tick(750);await f.tick(750);
 assert.equal(f.controller.snapshot().enabled,false);assert.equal(f.controller.snapshot().phase,'ERROR');assert.equal(f.state.rows[0].status,'AUTH_REQUIRED');assert.ok(f.state.pages.every(p=>p.closed));
 assert.equal(f.state.executions['exec-auto0'].status,'AUTH_REQUIRED');
});
test('six consecutive uncertain rounds stop the affected automation, not an infinite retry',async t=>{
 const f=await fixture(t,1);await f.enable();
 for(let i=0;i<6;i++){f.state.outcomes.push({ok:false,status:'ERROR',retryable:true,reason:'Unconfirmed'});f.state.messages.push(announcement('round-'+i));await f.tick(1000000)}
 await f.tick(750);assert.equal(f.state.sends.length,6);assert.equal(f.controller.snapshot().enabled,false);assert.equal(f.state.rows[0].status,'ERROR');
});
