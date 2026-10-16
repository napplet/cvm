import {test,expect} from "bun:test";
import {finalizeEvent,generateSecretKey,getPublicKey} from "nostr-tools/pure";
import {NappletDiscovery} from "../../src/dev-ui/browser/napplet-discovery";
import {remixManifest} from "../../src/remix/manifest";
import {discoveryRelay} from "../fixtures/discovery-relay";
test("applesauce discovers author outboxes, direct follows and hash-verified assets",async()=>{
 const directory=discoveryRelay(),mine=discoveryRelay(),friend=discoveryRelay(); const key=generateSecretKey(),other=generateSecretKey(); const now=Math.floor(Date.now()/1000);
 const html="<!doctype html><title>Real relay remix</title>"; const hash=new Bun.CryptoHasher("sha256").update(html).digest("hex");
 const blob=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(html)});
 const sign=(kind:number,tags:string[][],secret=key,content="")=>finalizeEvent({kind,tags,content,created_at:now},secret);
 directory.events.push(sign(10002,[["r",mine.url,"write"]]),sign(10002,[["r",friend.url,"write"]],other));
 mine.events.push(sign(3,[["p",getPublicKey(other)]]));
 const own=sign(35129,[["d","own"],["x",hash],["server",`http://127.0.0.1:${blob.port}`],["title","My napplet"]],key,"My own counter"); mine.events.push(own);
 const network=sign(35129,[["d","friend"],["x",hash],["title","Friend’s napplet"]],other,"Friend’s counter"); friend.events.push(network,{...network,id:"f".repeat(64),content:"tampered"});
 const discovery=new NappletDiscovery([directory.url],[directory.url]); const signal=AbortSignal.timeout(35000);
 try{
  expect((await discovery.browse(getPublicKey(key),false,signal)).map(x=>x.title)).toEqual(["My napplet"]);
  expect((await discovery.browse(getPublicKey(key),true,signal)).map(x=>x.title)).toEqual(["Friend’s napplet"]);
  expect((await discovery.browse(getPublicKey(key),false,signal)).length).toBe(1);
  expect((await discovery.resolve(remixManifest(own).naddr,signal)).html).toBe(html);
  expect(friend.requests.some(filters=>filters.some(f=>f.authors?.includes(getPublicKey(other))&&f.kinds?.includes(35129)))).toBe(true);
  expect(directory.requests.some(filters=>filters.some(f=>f.kinds?.includes(10002)))).toBe(true);
 }finally{discovery.close();directory.close();mine.close();friend.close();blob.stop(true);}
},40000);
