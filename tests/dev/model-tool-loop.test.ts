import { expect, test } from 'bun:test';
import { AuthoringLoopFailure, runAuthoringLoop, type AuthoringResponse } from '../../src/dev/model-tool-loop';
import { AuthoringToolRegistry } from '../../src/dev/authoring-tools';
import { ProviderOperationIntentSchema, NormalizedUsageReceiptSchema } from '../../src/model/model-gateway';

const intent = ProviderOperationIntentSchema.parse({ operationId:'op', providerRequestId:'request', accountId:'account', sessionId:'session', actionId:'action', expectedVersion:0, actionBudgetReference:'budget', profileId:'profile', priceCardId:'card', requestFingerprint:'a'.repeat(64), prompt:'Build a focused counter', maximumUnits:[{dimension:'input_tokens',units:'200000'},{dimension:'output_tokens',units:'1000'}], selection:'unselected' });
const call = (name: string, args: unknown, id='call') => ({ type:'function_call', name, call_id:id, arguments:JSON.stringify(args) });
const response = (id: string, output: Record<string, unknown>[]): AuthoringResponse => ({ id, output, usage:{input_tokens:100,output_tokens:20} });
function setup() {
  const turns: AuthoringResponse[] = []; const receipts: unknown[] = []; const requests: Record<string, unknown>[] = [];
  const receipt = (responses: readonly AuthoringResponse[]) => NormalizedUsageReceiptSchema.parse({ operationId:intent.operationId, providerRequestId:intent.providerRequestId, provider:'deterministic_fixture', model:'model', profileId:intent.profileId, priceCardId:intent.priceCardId, selection:'unselected', completedAt:'2026-11-09T00:00:00.000Z', provenance:{protectedEvidenceReference:'fixture:turns'}, usage:[{dimension:'input_tokens',units:String(responses.length*100)},{dimension:'output_tokens',units:String(responses.length*20)}] });
  return { turns, receipts, requests, options:{ intent, signal:new AbortController().signal, body:{model:'model',input:[{role:'developer',content:'Trusted source contract'},{role:'user',content:'Untrusted request'}]}, recordTurn:async (index: number, native: AuthoringResponse) => { expect(index).toBe(turns.length); turns.push(native); }, receipt, recordUsage:async (value: unknown) => { receipts.push(value); } } };
}
test('skills and Nostrbook results reach continuation after durable turn evidence', async () => {
  const state=setup();
  const registry=new AuthoringToolRegistry(async (tool,args) => { expect(state.turns).toHaveLength(1); expect(tool).toBe('read_nip'); expect(args).toEqual({nip:'01'}); return 'NIP-01 fixture documentation'; });
  const result=await runAuthoringLoop({ ...state.options, registry, request:async (body, turn) => {
    state.requests.push(body);
    if (!turn) return response('first',[call('read_authoring_resource',{name:'napplet-sdk',offset:null,length:null},'skill'),call('read_nostrbook',{tool:'read_nip',arguments_json:'{"nip":"01"}'},'nostr')]);
    expect(state.turns).toHaveLength(1);
    expect(body.max_output_tokens).toBe(980);
    const history=body.input as Record<string,unknown>[];
    expect(history[0]).toEqual(state.options.body.input[0]);
    expect(history.filter(item=>item.type==='function_call_output').map(item=>item.output).join('\n')).toContain('NIP-01 fixture documentation');
    expect(history.filter(item=>item.type==='function_call_output').map(item=>item.output).join('\n')).toContain('napplet-sdk');
    return response('last',[{type:'message'}]);
  } });
  expect(result.receipt.usage).toEqual([{dimension:'input_tokens',units:'200'},{dimension:'output_tokens',units:'40'}]);
  expect(state.turns).toHaveLength(2); expect(state.receipts).toHaveLength(1);
});
test('ambiguous second request retains earlier turn evidence without a partial final receipt', async () => {
  const state=setup(); let calls=0;
  try {
    await runAuthoringLoop({...state.options,request:async () => { if(calls++) throw new Error('connection lost'); return response('first',[call('read_authoring_resource',{name:'napplet-ui'})]); }});
    throw new Error('expected failure');
  } catch(error) { expect(error).toBeInstanceOf(AuthoringLoopFailure); expect((error as AuthoringLoopFailure).receipt).toBeUndefined(); }
  expect(calls).toBe(2); expect(state.turns).toHaveLength(1); expect(state.receipts).toHaveLength(0);
});
test('known continuation limit failure settles confirmed usage and sends no over-budget call', async () => {
  const state=setup(); let calls=0;
  try {
    await runAuthoringLoop({...state.options,intent:{...intent,maximumUnits:[{dimension:'input_tokens',units:'18000'},{dimension:'output_tokens',units:'1000'}]}, request:async () => { calls++; return response('first',[call('read_authoring_resource',{name:'threejs-shaders'})]); }});
    throw new Error('expected failure');
  } catch(error) { expect(error).toBeInstanceOf(AuthoringLoopFailure); expect((error as AuthoringLoopFailure).receipt?.usage[0].units).toBe('100'); }
  expect(calls).toBe(1); expect(state.receipts).toHaveLength(1);
});
test('call allowance is cumulative and a third turn is final-source only', async () => {
  const state=setup(); let requests=0;
  try {
    await runAuthoringLoop({...state.options,request:async (_body,turn) => { requests++; return response(String(turn),Array.from({length:turn?4:5},(_,i)=>call('read_authoring_resource',{name:'missing'},`${turn}-${i}`))); }});
    throw new Error('expected failure');
  } catch(error) { expect((error as AuthoringLoopFailure).receipt?.usage[0].units).toBe('200'); }
  expect(requests).toBe(2); expect(state.receipts).toHaveLength(1);
});
test('OAuth reserves a complete native output envelope before each uncapped call', async () => {
  const state=setup(); let requests=0;
  try { await runAuthoringLoop({...state.options,uncappedOutputEnvelope:1000,request:async (body) => { requests++;expect(body.max_output_tokens).toBeUndefined();return response('first',[call('read_authoring_resource',{name:'napplet-ui'})]); }}); }
  catch(error) { expect((error as AuthoringLoopFailure).receipt).toBeDefined(); }
  expect(requests).toBe(1);expect(state.receipts).toHaveLength(1);
});
