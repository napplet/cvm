import { expect, test } from "bun:test";
import { AUTHORING_TOOL_LIMITS, AuthoringToolRegistry } from "../../src/dev/authoring-tools";

test("authoring tools expose only manifest resources in bounded chunks", async () => {
  const registry = new AuthoringToolRegistry();
  const catalog = await registry.catalog();
  expect(catalog.slice(0, 6).map((resource) => resource.name)).toEqual(["napplet-make", "napplet-design", "napplet-ui", "napplet-build", "napplet-sdk", "napplet-test"]);
  expect(catalog.every((resource) => /^[a-f0-9]{64}$/u.test(resource.sha256))).toBe(true);
  const result = JSON.parse(await registry.readAuthoringResource({ name: "napplet-sdk", length: 200 }));
  expect(result).toMatchObject({ ok: true, name: "napplet-sdk", offset: 0 });
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(200);
  expect(JSON.parse(await registry.readAuthoringResource({ name: "../../package.json" }))).toEqual({ ok: false, code: "UNKNOWN_RESOURCE" });
  expect(JSON.parse(await registry.readAuthoringResource({ name: "napplet-sdk", length: AUTHORING_TOOL_LIMITS.maxResultBytes + 1 }))).toEqual({ ok: false, code: "INVALID_RANGE" });
});

test('function schemas meet strict Responses requirements and visual resources are readable', async () => {
  const registry=new AuthoringToolRegistry();
  for(const tool of registry.definitions()) {
    expect(tool.strict).toBe(true);expect(tool.parameters.additionalProperties).toBe(false);
    expect([...tool.parameters.required].sort().join(',')).toBe(Object.keys(tool.parameters.properties).sort().join(','));
  }
  const names=(await registry.catalog()).map(resource=>resource.name);
  expect(names).toContain('gsap-core');expect(names).toContain('threejs-fundamentals');
  expect(await registry.readAuthoringResource({name:'gsap-core'})).toContain('gsap.matchMedia');
  const first=JSON.parse(await registry.readAuthoringResource({name:'threejs-shaders'}));
  expect(first.nextOffset).toBeGreaterThan(0);
  const next=JSON.parse(await registry.readAuthoringResource({name:'threejs-shaders',offset:first.nextOffset}));
  expect(next.offset).toBe(first.nextOffset);expect(next.nextOffset).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(AUTHORING_TOOL_LIMITS.maxResultBytes);
});

test('MCP tool selection cannot invoke a relay or choose an arbitrary tool',async()=>{
  let calls=0;const registry=new AuthoringToolRegistry(async()=>{calls++;return 'unreachable';});
  const result=await registry.readNostrbook({tool:'read_custom_nip',arguments_json:'{}'},new AbortController().signal);
  expect(JSON.parse(result)).toEqual({ok:false,code:'UNKNOWN_NOSTRBOOK_TOOL'});expect(calls).toBe(0);
  expect(JSON.parse(await registry.execute('shell',{command:'ignored'},new AbortController().signal))).toEqual({ok:false,code:'UNKNOWN_TOOL'});
});
