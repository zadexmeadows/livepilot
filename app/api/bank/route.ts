import { z } from "zod";
import { apiError } from "@/lib/api";
import { bankWorker, initializeBank } from "@/lib/bank/worker";
import { analytics } from "@/lib/bank/analytics";
import { RoundService } from "@/lib/bank/rounds";
import { parseYouTubeUrl } from "@/lib/browser/youtube-chat";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const text=z.string().trim().min(1).max(500);
const integer=z.number().int().min(0).max(9_000_000_000_000);
const configSchema=z.object({economy:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),youtubeUrl:z.string().max(500),accountIds:z.array(text).max(100),bankAccountId:text.nullable(),protectedReserve:integer,minimumTransfer:integer.min(1),maximumTransfer:integer.min(1),delaySeconds:z.number().int().min(1).max(3600),responseTimeoutSeconds:z.number().int().min(10).max(120),bankPresenceMessage:text.max(200),autoConsolidate:z.boolean()}).strict();
const base={requestKey:text};
const schema=z.discriminatedUnion("action",[
 z.object({action:z.literal("configure"),config:configSchema}).strict(),
 z.object({action:z.literal("verify"),accountId:text.optional(),...base}).strict(),
 z.object({action:z.literal("transfer"),sender:text,receiver:text,amount:integer.min(1),...base}).strict(),
 z.object({action:z.literal("accumulate"),...base}).strict(),
 z.object({action:z.literal("stop")}).strict(),
 z.object({action:z.literal("adjust"),accountId:text,amount:z.number().int().min(-9_000_000_000_000).max(9_000_000_000_000),reason:text,...base}).strict(),
 z.object({action:z.literal("reverse"),entryId:z.number().int().positive(),reason:text,...base}).strict(),
 z.object({action:z.literal("freeze"),accountId:text,frozen:z.boolean(),reason:text}).strict(),
 z.object({action:z.literal("resolve-transfer"),transferId:text,reason:text}).strict(),
 z.object({action:z.literal("reconcile-round"),roundId:text,participants:z.array(z.object({accountId:text,stake:integer.min(1),payout:integer})).min(1).max(100),reason:text,...base}).strict(),
]);
export async function GET(request:Request) {
 try {
  const {l,profiles,config}=await initializeBank(), params=new URL(request.url).searchParams;
  const page=Math.max(1,Math.min(100000,Number(params.get("page"))||1)), size=50;
  const clauses=["a.economy=?"], args:(string|number)[]=[config.economy];
  for(const [param,column] of [["account","e.accountId"],["type","e.type"],["round","e.reference"],["stream","e.stream"]]) if(params.get(param)){clauses.push(`${column}=?`);args.push(params.get(param)!);}
  for(const [param,op] of [["from",">="],["to","<="]]) if(params.get(param)){const date=new Date(params.get(param)!);if(Number.isNaN(date.valueOf()))throw new Error("Invalid date filter.");clauses.push(`e.createdAt${op}?`);args.push(date.toISOString());}
  if(params.get("search")){clauses.push("(e.reason LIKE ? OR e.reference LIKE ? OR a.name LIKE ?)");const q=`%${params.get("search")!.slice(0,200)}%`;args.push(q,q,q);}
  const where=clauses.join(" AND "), direction=params.get("sort")==="asc"?"ASC":"DESC";
  const entries=l.rows(`SELECT e.*,a.name FROM BankEntry e JOIN BankAccount a ON a.id=e.accountId WHERE ${where} ORDER BY e.id ${direction} LIMIT ? OFFSET ?`,...args,size,(page-1)*size);
  const count=Number(l.one(`SELECT COUNT(*) count FROM BankEntry e JOIN BankAccount a ON a.id=e.accountId WHERE ${where}`,...args)?.count??0);
  const rounds=l.rows("SELECT * FROM BankRound WHERE economy=? ORDER BY createdAt DESC LIMIT 50",config.economy).map(r=>({...r,participants:l.rows("SELECT p.*,a.name,a.handle FROM BankParticipant p JOIN BankAccount a ON a.id=p.accountId WHERE roundId=?",String(r.id))}));
  return Response.json({config,profiles:profiles.map(a=>({id:a.id,name:a.displayName,handle:a.channelName,status:a.status})),...analytics(l,config.economy),entries,pagination:{page,size,count},rounds,transfers:l.rows("SELECT t.*,a.name senderName,b.name receiverName FROM BankTransfer t JOIN BankAccount a ON a.id=t.sender JOIN BankAccount b ON b.id=t.receiver WHERE a.economy=? ORDER BY createdAt DESC LIMIT 100",config.economy),verifications:l.rows("SELECT v.*,a.name FROM BankVerification v JOIN BankAccount a ON a.id=v.accountId WHERE a.economy=? ORDER BY createdAt DESC LIMIT 100",config.economy),jobs:l.rows("SELECT * FROM BankJob ORDER BY createdAt DESC LIMIT 20"),audit:l.rows("SELECT * FROM BankAudit ORDER BY id DESC LIMIT 100"),legacy:JSON.parse(String(l.one("SELECT value FROM BankMeta WHERE key='legacy-import'")?.value??'{}'))},{headers:{"Cache-Control":"no-store"}});
 }catch(error){return apiError(error,"Could not load bank.");}
}
export async function POST(request:Request){
 try{
  if(!request.headers.get("content-type")?.startsWith("application/json"))return Response.json({error:"Expected JSON."},{status:415});
  const origin=request.headers.get("origin");if(request.headers.get("sec-fetch-site")==="cross-site"||(origin&&new URL(origin).host!==(request.headers.get("host")||new URL(request.url).host)))return Response.json({error:"Cross-site writes are not allowed."},{status:403});
  const body=schema.parse(await request.json()),{l,profiles}=await initializeBank();
  let result:unknown;
  if(body.action==="configure"){
   const config=body.config;
   if(config.youtubeUrl)config.youtubeUrl=parseYouTubeUrl(config.youtubeUrl).canonicalUrl;
   if(config.minimumTransfer>config.maximumTransfer)throw new Error("Minimum transfer exceeds maximum.");
   if(new Set(config.accountIds).size!==config.accountIds.length||config.accountIds.some(id=>!profiles.some(a=>a.id===id)))throw new Error("Choose existing, unique accounts.");
   if(config.bankAccountId&&!config.accountIds.includes(config.bankAccountId))throw new Error("The bank destination must be selected.");
   l.saveConfig(config);result=config;
  }else if(body.action==="verify")result=await bankWorker.start("VERIFY",body.requestKey,{...(body.accountId?{accountId:body.accountId}:{})});
  else if(body.action==="transfer")result=await bankWorker.start("TRANSFER",body.requestKey,{sender:body.sender,receiver:body.receiver,amount:body.amount});
  else if(body.action==="accumulate")result=await bankWorker.start("ACCUMULATE",body.requestKey);
  else if(body.action==="stop")await bankWorker.stop();
  else if(body.action==="adjust")result=l.adjust(body.accountId,body.amount,body.reason,body.requestKey);
  else if(body.action==="reverse")result=l.reverse(body.entryId,body.reason,body.requestKey);
  else if(body.action==="freeze")l.freeze(body.accountId,body.frozen,body.reason);
  else if(body.action==="resolve-transfer")l.resolveUncertain(body.transferId,body.reason);
  else if(body.action==="reconcile-round")result=new RoundService(l).reconcile(body.roundId,body.participants,body.reason,body.requestKey);
  return Response.json({ok:true,result});
 }catch(error){return apiError(error,"Bank operation failed.",400);}
}
