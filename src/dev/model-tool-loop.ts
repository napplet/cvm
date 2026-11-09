import type { NormalizedUsageReceipt, ProviderOperationIntent } from '../model/model-gateway';
import { AUTHORING_TOOL_LIMITS, AuthoringToolRegistry } from './authoring-tools';

export type AuthoringResponse = { id: string; output: readonly Record<string, unknown>[]; usage: { input_tokens: number; output_tokens: number } };
export class AuthoringLoopFailure extends Error {
  constructor(readonly cause: unknown, readonly receipt?: NormalizedUsageReceipt) { super(cause instanceof Error ? cause.message : 'MODEL_TOOL_LOOP_FAILED'); }
}

/** One bounded conversation, one approved operation, one aggregate receipt. */
export async function runAuthoringLoop<T extends AuthoringResponse>(options: {
  intent: ProviderOperationIntent;
  signal: AbortSignal;
  body: Record<string, unknown> & { input: unknown[] };
  request: (body: Record<string, unknown>, turn: number) => Promise<T>;
  recordTurn: (turn: number, native: T) => Promise<void>;
  receipt: (natives: readonly T[]) => NormalizedUsageReceipt;
  recordUsage: (receipt: NormalizedUsageReceipt) => Promise<void>;
  registry?: AuthoringToolRegistry;
  /** SIWC cannot cap output; reserve its full native envelope before each call. */
  uncappedOutputEnvelope?: number;
  definitiveRejection?: (error: unknown) => boolean;
}): Promise<{ native: T; receipt: NormalizedUsageReceipt }> {
  const registry = options.registry ?? new AuthoringToolRegistry();
  const maximum = (dimension: string) => BigInt(options.intent.maximumUnits.find(line => line.dimension === dimension)?.units ?? '0');
  const responses: T[] = [];
  const history = [...options.body.input];
  let calls = 0; let toolBytes = 0; let pending = false;
  async function settle() {
    const receipt = options.receipt(responses);
    await options.recordUsage(receipt);
    return receipt;
  }
  try {
    for (let turn = 0; turn < AUTHORING_TOOL_LIMITS.maxTurns; turn++) {
      options.signal.throwIfAborted();
      const inputRemaining = maximum('input_tokens') - responses.reduce((sum, item) => sum + BigInt(item.usage.input_tokens), 0n);
      const outputRemaining = maximum('output_tokens') - responses.reduce((sum, item) => sum + BigInt(item.usage.output_tokens), 0n);
      if (outputRemaining < BigInt(options.uncappedOutputEnvelope ?? 1)) throw new Error('MODEL_OUTPUT_CEILING_EXHAUSTED');
      const body = { ...options.body, input: history,
        ...(!options.uncappedOutputEnvelope ? { max_output_tokens: Number(outputRemaining) } : {}),
        tool_choice: turn === 0 ? 'required' : turn === AUTHORING_TOOL_LIMITS.maxTurns - 1 ? 'none' : 'auto' };
      // UTF-8 bytes conservatively bound text tokens, including all carried
      // history and schemas; earlier paid input is never forgotten.
      if (BigInt(Buffer.byteLength(JSON.stringify(body)) + 512) > inputRemaining) throw new Error('MODEL_INPUT_CEILING_EXHAUSTED');
      pending = true;
      let native: T;
      try { native = await options.request(body, turn); }
      catch (error) { if (options.definitiveRejection?.(error)) pending = false; throw error; }
      responses.push(native);
      // Receipt binding/limits and durable evidence precede any tool or next request.
      options.receipt(responses);
      await options.recordTurn(turn, native);
      pending = false;
      const toolCalls = native.output.filter(item => item.type === 'function_call');
      if (!toolCalls.length) return { native, receipt: await settle() };
      calls += toolCalls.length;
      if (turn === AUTHORING_TOOL_LIMITS.maxTurns - 1 || calls > AUTHORING_TOOL_LIMITS.maxCalls) throw new Error('MODEL_TOOL_LIMIT_EXCEEDED');
      history.push(...native.output);
      for (const call of toolCalls) {
        if (typeof call.call_id !== 'string' || !call.call_id || call.call_id.length > 256 || typeof call.arguments !== 'string' || call.arguments.length > 32_000) throw new Error('MODEL_TOOL_CALL_INVALID');
        let output: string;
        try { output = await registry.execute(String(call.name), JSON.parse(call.arguments), options.signal); }
        catch { output = JSON.stringify({ ok: false, code: 'INVALID_TOOL_ARGUMENTS' }); }
        toolBytes += Buffer.byteLength(output);
        if (Buffer.byteLength(output) > AUTHORING_TOOL_LIMITS.maxResultBytes || toolBytes > AUTHORING_TOOL_LIMITS.maxTotalBytes) throw new Error('MODEL_TOOL_OUTPUT_LIMIT_EXCEEDED');
        history.push({ type: 'function_call_output', call_id: call.call_id, output });
      }
    }
    throw new Error('MODEL_TOOL_LIMIT_EXCEEDED');
  } catch (error) {
    if (responses.length && !pending) {
      let receipt: NormalizedUsageReceipt | undefined;
      try { receipt = await settle(); } catch { /* Conflicting or unavailable evidence remains uncertain. */ }
      throw new AuthoringLoopFailure(error, receipt);
    }
    // No complete aggregate can be asserted after an uncertain request or a
    // conflicting evidence write. Confirmed turn rows remain for reconciliation.
    throw new AuthoringLoopFailure(error);
  }
}
