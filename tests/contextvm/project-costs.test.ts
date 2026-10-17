import { expect, test } from "bun:test";
import { costLines, readProjectCosts } from "../../src/dev/project-costs";
import { PHASE_04_DETERMINISTIC_PRICE_CARD as card } from "../../src/model/price-card";
import { DevelopmentProjects } from "../../src/dev/projects";
import { accountIdForPrincipal } from "../../src/domain/account-command";

test("breakdown rounds each pinned rate and reconciles exactly to the committed debit", () => {
  const usage = [{dimension:"input_tokens",units:"1"},{dimension:"cached_tokens",units:"3"}];
  expect(costLines(usage,card,"3").map(line=>line.charge)).toEqual(["1","2"]);
  expect(costLines(usage,card,"2")).toEqual([]);
  expect(costLines(usage,card,null)).toEqual([]);
  expect(costLines([...usage,usage[0]],card,"4")).toEqual([]);
  expect(costLines([{dimension:"input_tokens",units:"0"}],card,"0")[0]?.charge).toBe("0");
  expect(costLines([{dimension:"input_tokens",units:"9007199254740993"}],card,"9007199254740993")[0]?.charge).toBe("9007199254740993");
});
test("cost requests reject caller-supplied identities before accessing SQL", async () => {
  const projects = new DevelopmentProjects({query:async()=>{throw new Error("SQL_MUST_NOT_RUN");}} as any);
  for (const extra of [{pubkey:"a".repeat(64)},{accountId:"other"},{owner:"other"},{limit:51}])
    await expect(projects.handle({action:"costs",id:"session:1",...extra},"b".repeat(64))).rejects.toThrow();
});
test("history exposes only display fields; paginated totals stay authoritative and unknown is null", async () => {
  const pubkey = "a".repeat(64); let args: unknown[] = [];
  const entry = {id:"action:2",requestKey:"key:2",number:2,kind:"revise",prompt:"A change",state:"usage_unknown",version:null,createdAt:new Date().toISOString(),charge:null,maximum:"100",usage:null,card:{private:"do not expose"}};
  const result = await readProjectCosts({query:async(_sql:string,values:unknown[])=>{args=values;return {rows:[{total:{confirmed:"42",pending:1,requests:3},entries:[entry,{...entry,id:"action:1"}]}]};}} as any,pubkey,"session:1",1);
  expect(args).toEqual([await accountIdForPrincipal({pubkey}),"session:1",null,2]);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("missing costs");
  expect(result.costs.total.confirmed).toBe("42"); expect(result.costs.requests).toHaveLength(1);
  expect(result.costs.requests[0]?.charge).toBeNull(); expect(result.costs.nextCursor).toBe("action:2");
  expect(JSON.stringify(result)).not.toContain("private"); expect(JSON.stringify(result)).not.toContain('"card"');
});
