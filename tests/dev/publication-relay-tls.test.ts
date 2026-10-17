import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

test("relay socket pins DNS, verifies TLS hostname and refuses redirects", async () => {
  const dir = await mkdtemp(join(tmpdir(),"cvm-relay-tls-"));
  const event = finalizeEvent({kind:35129,created_at:Math.floor(Date.now()/1000),tags:[],content:""},generateSecretKey());
  let server: ReturnType<typeof Bun.serve> | undefined; let redirect: ReturnType<typeof Bun.serve> | undefined; let connections = 0; let resent = 0;
  try {
    const cert = join(dir,"cert.pem"); const key = join(dir,"key.pem");
    const openssl = Bun.spawn(["openssl","req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=relay.test","-addext","subjectAltName=DNS:relay.test"],{stdout:"ignore",stderr:"ignore"});
    expect(await openssl.exited).toBe(0);
    server = Bun.serve({port:0,tls:{key:Bun.file(key),cert:Bun.file(cert)},fetch(request,server){ connections++; if(server.upgrade(request, {data:undefined}))return;return new Response("no"); },websocket:{message(ws,message){ const request=JSON.parse(String(message)); if(request[0]==="EVENT"){expect(request[1].id).toBe(event.id);resent++;ws.send(JSON.stringify(["OK",event.id,true,""]));} if(request[0]==="REQ"){ws.send(JSON.stringify(["EVENT",request[1],event]));ws.send(JSON.stringify(["EOSE",request[1]]));} }}});
    async function run(url:string, send:boolean | "always" = false) {
      const process=Bun.spawn([Bun.which("node")!,fileURLToPath(new URL("../../src/dev/publication-relay-worker.mjs",import.meta.url))],{env:{NODE_EXTRA_CA_CERTS:cert},stdin:new Blob([JSON.stringify({url,address:{address:"127.0.0.1",family:4},event,send})]),stdout:"pipe",stderr:"ignore"});
      const result=JSON.parse(await new Response(process.stdout).text()); expect(await process.exited).toBe(0);return result.confirmed;
    }
    expect(await run(`wss://relay.test:${server.port}`)).toBe(true); expect(connections).toBe(1);
    expect(await run(`wss://wrong.test:${server.port}`)).toBe(false); expect(connections).toBe(1);
    redirect=Bun.serve({port:0,fetch(){return Response.redirect(`https://relay.test:${server!.port}`,302);}});
    expect(await run(`ws://relay.test:${redirect.port}`)).toBe(false); expect(connections).toBe(1);
    expect(resent).toBe(0);
    expect(await run(`wss://relay.test:${server.port}`, "always")).toBe(true); expect(resent).toBe(1);
    expect(await run(`wss://relay.test:${server.port}`, true)).toBe(true); expect(resent).toBe(1);
  } finally { server?.stop(true);redirect?.stop(true);await rm(dir,{recursive:true,force:true}); }
},20000);
