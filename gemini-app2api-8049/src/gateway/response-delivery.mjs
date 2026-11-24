// OpenAI-format delivery: text is forwarded while generation is in progress.
// A downstream 200 is not a claim that an interrupted response completed.
import crypto from 'node:crypto';
import { writeChatResponse, writeResponsesResponse, toChatAnnotations } from '../openai-contract.mjs';
import { writeGoogleResponse } from '../Google-contract.mjs';
import { writeGeminiResponse, buildGeminiResponsePayload, buildGeminiErrorPayload } from '../gemini-contract.mjs';
import { protocolError as fault } from '../tool-protocol.mjs';
import { responsesCallFields } from '../responses-tool-namespaces.mjs';
import { toResponsesUsage, estimateUsage as estimateTokenUsage } from '../openai-usage.mjs';
const MAX = 8 * 1024 * 1024;
// Hold the very first text fragment instead of flushing it immediately. An
// interrupted turn that produced only this tiny prefix has not shown the caller
// anything, so the pool may discard it and retry once without splicing output.
const PREFIX_BYTES = 2048;
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'UPSTREAM_INTERRUPTED';
const commonPrefixBytes = (prior, next) => {
  const limit = Math.min(prior.length, next.length);
  let i = 0;
  while (i < limit && prior.charCodeAt(i) === next.charCodeAt(i)) i++;
  return Buffer.byteLength(prior.slice(0, i));
};
function abortReasonFault(signal) {
  return signal?.reason?.code === 'REQUEST_DEADLINE'
    ? fault('NATIVE_TURN_TIMEOUT', 504)
    : fault('REQUEST_CANCELLED', 499);
}
async function write(res, chunk, signal = null, writeTimeoutMs = 30000) {
  if (res.destroyed || res.writableEnded) throw fault('REQUEST_CANCELLED', 499);
  if (res.write(chunk) !== false) return;
  if (signal?.aborted) {
    if (!res.destroyed && !res.writableEnded) res.destroy?.();
    throw abortReasonFault(signal);
  }
  await new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      res.off('drain', drain);
      res.off('close', close);
      res.off('error', close);
      signal?.removeEventListener('abort', onAbort);
    };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(fault('REQUEST_CANCELLED', 499)); };
    const onAbort = () => {
      cleanup();
      if (!res.destroyed && !res.writableEnded) res.destroy?.();
      reject(abortReasonFault(signal));
    };
    const onTimeout = () => {
      cleanup();
      if (!res.destroyed && !res.writableEnded) res.destroy?.();
      reject(fault('NATIVE_TURN_TIMEOUT', 504));
    };
    res.once('drain', drain);
    res.once('close', close);
    res.once('error', close);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(writeTimeoutMs) && writeTimeoutMs > 0) {
      timer = setTimeout(onTimeout, writeTimeoutMs);
    }
    if (res.destroyed || res.writableEnded) close();
    else if (signal?.aborted) onAbort();
  });
}
export function createResponseDelivery(res, { route = 'chat', stream = false, geminiSse = true, includeUsage = false, model, thinkingLevel, reasoningEffort, parallelToolCalls = true, promptChars, imageCount = 0, deferEmptyStart = false, signal = null, writeTimeoutMs = 30000, keepaliveMs = 15000, keepaliveHeadersDelayMs = 12000 } = {}) {
  let meta = { id: 'chatcmpl-' + crypto.randomBytes(16).toString('hex'), created: Math.floor(Date.now() / 1000), model,
    requestedThinkingLevel: thinkingLevel, ...(reasoningEffort === undefined ? {} : { requestedReasoningEffort: reasoningEffort }) };
  let started = false, keepaliveHeadersSent = false, settled = false, content = '', calls = [], bytes = 0, sequence = 0, message = null;
  let publishedLength = 0, publishedBytes = 0;
  let googleBlockIndex = 0, googleTextOpen = false;
  let geminiArrayFirst = true;
  let keepaliveTimer = null, deferredHeaderTimer = null;
  const stopDeferredHeaderTimer = () => {
    if (deferredHeaderTimer !== null) {
      clearTimeout(deferredHeaderTimer);
      deferredHeaderTimer = null;
    }
  };
  const stopKeepalive = () => {
    stopDeferredHeaderTimer();
    if (keepaliveTimer !== null) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
    res.off?.('close', stopKeepalive);
    res.off?.('error', stopKeepalive);
    signal?.removeEventListener?.('abort', stopKeepalive);
  };
  const armKeepalive = () => {
    if (!stream || (route === 'gemini' && !geminiSse) || settled || (!started && !keepaliveHeadersSent) || !Number.isFinite(keepaliveMs) || keepaliveMs <= 0) return;
    if (keepaliveTimer !== null) clearTimeout(keepaliveTimer);
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = null;
      if (settled || (route === 'gemini' && !geminiSse) || res.destroyed || res.writableEnded) { stopKeepalive(); return; }
      if (!res.writableNeedDrain) {
        try {
          if (typeof res.writeKeepalive === 'function') res.writeKeepalive(': keepalive\n\n');
          else res.write(': keepalive\n\n');
        } catch { stopKeepalive(); return; }
      }
      armKeepalive();
    }, keepaliveMs);
    keepaliveTimer.unref?.();
  };
  const writeSseHeaders = (extraHeaders = {}) => {
    if (!res.headersSent) {
      const isGeminiJsonArray = route === 'gemini' && !geminiSse;
      res.writeHead(200, {
        'Content-Type': isGeminiJsonArray ? 'application/json; charset=utf-8' : 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...(isGeminiJsonArray ? {} : { Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }),
        'X-Gemini-Usage': 'estimated',
        'X-Requested-Thinking-Level': String(meta.requestedThinkingLevel ?? ''),
        ...(Number.isSafeInteger(meta.thinkingLevel) ? { 'X-Thinking-Level': String(meta.thinkingLevel) } : {}),
        ...(Number.isSafeInteger(meta.resolvedModeCategory) ? { 'X-Native-Mode': String(meta.resolvedModeCategory) } : {}),
        ...(meta.requestedReasoningEffort === undefined ? {} : { 'X-Reasoning-Effort': meta.requestedReasoningEffort }),
        ...(meta.ignoredTokenParameters?.length ? { 'X-Gemini-Token-Limit': 'not-enforced', 'X-Gemini-Ignored-Parameters': meta.ignoredTokenParameters.join(', ') } : {}),
        ...extraHeaders,
      });
      res.flushHeaders?.();
    }
  };
  const flushKeepaliveHeaders = () => {
    deferredHeaderTimer = null;
    if (!stream || (route === 'gemini' && !geminiSse) || !deferEmptyStart || settled || started || keepaliveHeadersSent || res.headersSent || res.destroyed || res.writableEnded || signal?.aborted) return;
    try {
      res.removeHeader?.('X-Gemini-Provider-Attempts');
      res.removeHeader?.('X-Gemini-Failover-Count');
      res.removeHeader?.('X-Gemini-Failover-Reason');
      res.removeHeader?.('X-Gemini-Recovery-Errors');
      writeSseHeaders({ 'X-Gemini-Keepalive-Headers': '1' });
      keepaliveHeadersSent = true;
      if (!res.writableNeedDrain) {
        if (typeof res.writeKeepalive === 'function') res.writeKeepalive(': keepalive\n\n');
        else res.write(': keepalive\n\n');
      }
      armKeepalive();
    } catch {
      stopKeepalive();
    }
  };
  if (stream && !(route === 'gemini' && !geminiSse) && deferEmptyStart && Number.isFinite(keepaliveHeadersDelayMs) && keepaliveHeadersDelayMs > 0) {
    res.once?.('close', stopKeepalive);
    res.once?.('error', stopKeepalive);
    signal?.addEventListener?.('abort', stopKeepalive, { once: true });
    deferredHeaderTimer = setTimeout(flushKeepaliveHeaders, keepaliveHeadersDelayMs);
    deferredHeaderTimer.unref?.();
  }
  // Ordinary upstream responses carry no token accounting. Usage is therefore a
  // labelled estimate over the caller request and the delivered output, never a
  // value read from Google.
  const estimateUsage = (outputBytes = bytes) => estimateTokenUsage({ promptChars, imageCount, outputBytes });
  const output = [];
  const sendWire = async chunk => {
    await write(res, chunk, signal, writeTimeoutMs);
    armKeepalive();
  };
  const responseId = () => meta.id.startsWith('resp_') ? meta.id : 'resp_' + meta.id.replace(/^chatcmpl-/, '');
  const chatBase = () => ({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model,
    ...(meta.requestedReasoningEffort === undefined ? {} : { reasoning_effort: meta.requestedReasoningEffort }) });
  const response = (status, error = null) => ({ id: responseId(), object: 'response', created_at: meta.created, status,
    error, ...(error ? { incomplete: true } : {}), incomplete_details: error ? { reason: 'upstream_interrupted', code: error.code } : null, model: meta.model,
    output: output.map(item => ({ ...item, status: status === 'completed' ? 'completed' : 'incomplete' })),
    usage: status === 'in_progress' ? null : toResponsesUsage(estimateUsage()),
    parallel_tool_calls: parallelToolCalls, ...(meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
    ...(meta.requestedReasoningEffort === undefined ? {} : { reasoning: { effort: meta.requestedReasoningEffort } }) });
  const sendChat = (delta, finish_reason = null) => sendWire('data: ' + JSON.stringify({ ...chatBase(),
    ...(finish_reason && meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
    choices: [{ index: 0, delta, finish_reason }], ...(includeUsage ? { usage: estimateUsage() } : {}) }) + '\n\n');
  const sendResponse = (type, data) => sendWire('event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: sequence++, ...data }) + '\n\n');
  const sendGoogleEvent = (type, data) => sendWire('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
  const sendGeminiChunk = async (chunk) => {
    if (geminiSse) {
      await sendWire('data: ' + JSON.stringify(chunk) + '\n\n');
    } else {
      const prefix = geminiArrayFirst ? '' : ',';
      geminiArrayFirst = false;
      await sendWire(prefix + JSON.stringify(chunk));
    }
  };
  const writeNonStream = (payload) => {
    if (route === 'google') return writeGoogleResponse(res, payload);
    if (route === 'gemini') return writeGeminiResponse(res, payload);
    if (route === 'responses') return writeResponsesResponse(res, payload);
    return writeChatResponse(res, payload);
  };
  async function finishResponseItems() {
    for (const item of output) {
      if (item.status === 'completed') continue;
      const locator = { item_id: item.id, output_index: output.indexOf(item) };
      if (item.type === 'message') {
        const position = { ...locator, content_index: 0 };
        const part = item.content[0];
        for (let annotation_index = 0; annotation_index < part.annotations.length; annotation_index++) {
          await sendResponse('response.output_text.annotation.added', { ...position, annotation_index, annotation: part.annotations[annotation_index] });
        }
        await sendResponse('response.output_text.done', { ...position, text: part.text, logprobs: [] });
        await sendResponse('response.content_part.done', { ...position, part });
      } else await sendResponse('response.function_call_arguments.done', { ...locator, name: item.name, arguments: item.arguments });
      item.status = 'completed';
      await sendResponse('response.output_item.done', { output_index: locator.output_index, item });
    }
  }
  // Emit one text delta on the client format and count what the caller actually saw.
  async function emitText(delta) {
    if (!stream || !delta) return;
    if (route === 'chat') { await sendChat({ content: delta }); publishedBytes += Buffer.byteLength(delta); return; }
    if (route === 'google') {
      if (!googleTextOpen) {
        await sendGoogleEvent('content_block_start', { index: googleBlockIndex, content_block: { type: 'text', text: '' } });
        googleTextOpen = true;
      }
      await sendGoogleEvent('content_block_delta', { index: googleBlockIndex, delta: { type: 'text_delta', text: delta } });
      publishedBytes += Buffer.byteLength(delta);
      return;
    }
    if (route === 'gemini') {
      await sendGeminiChunk(buildGeminiResponsePayload({ model: meta.model, content: delta, calls: [] }, { includeFinish: false }));
      publishedBytes += Buffer.byteLength(delta);
      return;
    }
    if (!message) {
      message = { id: 'msg_' + crypto.randomBytes(12).toString('hex'), type: 'message', status: 'in_progress', role: 'assistant',
        content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }] };
      output.push(message);
      await sendResponse('response.output_item.added', { output_index: output.indexOf(message), item: { ...message, content: [] } });
      await sendResponse('response.content_part.added', { item_id: message.id, output_index: output.indexOf(message), content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
    }
    message.content[0].text = content;
    await sendResponse('response.output_text.delta', { item_id: message.id, output_index: output.indexOf(message), content_index: 0, delta, logprobs: [] });
    publishedBytes += Buffer.byteLength(delta);
  }
  // Flush text the prefix gate is still holding.
  async function emitHeld() {
    if (!stream || content.length <= publishedLength) return;
    const delta = content.slice(publishedLength);
    publishedLength = content.length;
    await emitText(delta);
  }

  async function start(identity) {
    if (settled) return;
    if (!started && identity) meta = { ...meta, ...identity };
    if (!stream || started) return;
    stopDeferredHeaderTimer();
    started = true;
    writeSseHeaders();
    res.once?.('close', stopKeepalive);
    res.once?.('error', stopKeepalive);
    signal?.addEventListener?.('abort', stopKeepalive, { once: true });
    if (!(route === 'gemini' && !geminiSse)) armKeepalive();
    if (route === 'chat') await sendChat({ role: 'assistant' });
    else if (route === 'google') {
      const msgId = typeof meta.id === 'string' && meta.id.startsWith('msg_') ? meta.id : 'msg_' + crypto.randomBytes(12).toString('hex');
      await sendGoogleEvent('message_start', {
        message: {
          id: msgId, type: 'message', role: 'assistant', model: meta.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: estimateUsage(0).prompt_tokens, output_tokens: 0 },
        },
      });
    } else if (route === 'gemini') {
      if (!geminiSse) await sendWire('[');
    } else { const initial = response('in_progress'); await sendResponse('response.created', { response: initial }); await sendResponse('response.in_progress', { response: initial }); }
  }
  async function accept(event) {
    if (settled) throw fault('OUTPUT_ALREADY_FINISHED', 502);
    if (event.reset) {
      if (event.sameResponseIdentity !== true || (stream && (publishedBytes > 0 || calls.length > 0))) throw Object.assign(fault('NON_MONOTONIC_NATIVE_RESPONSE', 502), {
        nativeEvidence: { phase: 'output', nonMonotonicSite: 'delivery_reset', sameResponseIdentity: event.sameResponseIdentity === true,
          snapshotPriorBytes: Buffer.byteLength(content), snapshotNextBytes: 0,
          snapshotCommonPrefixBytes: 0, publishedBytes, toolCallCount: calls.length } });
      content = ''; calls = []; bytes = 0; publishedLength = 0; publishedBytes = 0; message = null; output.length = 0; return;
    }
    if (event.start) {
      if (deferEmptyStart && !started) meta = { ...meta, ...event.response };
      else await start(event.response);
      return;
    }
    if (event.response && !started) meta = { ...meta, ...event.response };
    if (typeof event.content === 'string' && event.content.length) {
      const nextBytes = bytes + Buffer.byteLength(event.content);
      if (nextBytes > MAX) throw fault('RESPONSE_TOO_LARGE', 502);
      bytes = nextBytes;
      // Hold SSE headers and initial events behind the prefix gate when deferEmptyStart
      // is enabled so a short-fragment failure never commits downstream headers before retry.
      const holdPrefix = stream && deferEmptyStart && !started && !publishedLength && nextBytes < PREFIX_BYTES;
      if (!holdPrefix) await start(event.response);
      content += event.content;
      if (!stream) return;
      // Hold a tiny prefix back until real output exists, so an interruption
      // here can still be retried instead of delivering a useless fragment.
      if (!publishedLength && bytes < PREFIX_BYTES) return;
      await emitHeld();
    }
    if (event.call) {
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(event.call));
      if (calls.length >= 32 || nextBytes > MAX) throw fault('RESPONSE_TOO_LARGE', 502);
      bytes = nextBytes;
      await start(event.response);
      calls.push(event.call);
      if (!stream) return;
      // A tool call is committed output: release any text held before it.
      await emitHeld();
      if (route === 'chat') await sendChat({ tool_calls: [{ index: calls.length - 1, ...event.call }] });
      else if (route === 'google') {
        if (googleTextOpen) {
          await sendGoogleEvent('content_block_stop', { index: googleBlockIndex });
          googleBlockIndex++;
          googleTextOpen = false;
        }
        const idx = googleBlockIndex++;
        await sendGoogleEvent('content_block_start', {
          index: idx,
          content_block: { type: 'tool_use', id: event.call.id, name: event.call.function.name, input: {} },
        });
        await sendGoogleEvent('content_block_delta', {
          index: idx,
          delta: { type: 'input_json_delta', partial_json: event.call.function.arguments || '{}' },
        });
        await sendGoogleEvent('content_block_stop', { index: idx });
      } else if (route === 'gemini') {
        await sendGeminiChunk(buildGeminiResponsePayload({ model: meta.model, content: '', calls: [event.call] }, { includeFinish: false }));
      } else {
        const item = { id: 'fc_' + crypto.randomBytes(12).toString('hex'), type: 'function_call', status: 'in_progress',
          ...responsesCallFields(event.call, meta) };
        output.push(item); const locator = { item_id: item.id, output_index: output.indexOf(item) };
        await sendResponse('response.output_item.added', { output_index: locator.output_index, item: { ...item, arguments: '' } });
        await sendResponse('response.function_call_arguments.delta', { ...locator, delta: item.arguments });
      }
    }
  }
  async function complete(result) {
    if (settled) return;
    if (!stream) {
      const resultCalls = Array.isArray(result.calls) ? result.calls : [];
      const outputBytes = Buffer.byteLength(result.content ?? '') +
        resultCalls.reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call)), 0);
      if (resultCalls.length > 32 || outputBytes > MAX) throw fault('RESPONSE_TOO_LARGE', 502);
      settled = true;
      writeNonStream({ ...result, parallelToolCalls, usage: estimateUsage(outputBytes) });
      return;
    }
    if (!started) meta = { ...meta, ...result };
    else for (const key of ['nativeSearch', 'thinkingLevel', 'annotations']) if (result[key] !== undefined) meta[key] = result[key];
    if (!result.content.startsWith(content)) {
      const sameResponse = result.id === meta.id && result.nativeEvidence?.nativeResponseIdentityVerified === true;
      if (publishedBytes > 0 || calls.length > 0 || !sameResponse) throw Object.assign(fault('NON_MONOTONIC_NATIVE_RESPONSE', 502), {
        nativeEvidence: { phase: 'output', nonMonotonicSite: 'delivery_final', sameResponseIdentity: sameResponse,
          snapshotPriorBytes: Buffer.byteLength(content), snapshotNextBytes: Buffer.byteLength(result.content),
          snapshotCommonPrefixBytes: commonPrefixBytes(content, result.content), publishedBytes, toolCallCount: calls.length } });
      content = ''; bytes = 0; publishedLength = 0; message = null; output.length = 0;
    }
    if (result.content.length > content.length) await accept({ content: result.content.slice(content.length), response: meta });
    for (const call of result.calls) if (!calls.some(prior => prior.id === call.id)) await accept({ call, response: meta });
    if (calls.length !== result.calls.length || calls.some((call, i) => JSON.stringify(call) !== JSON.stringify(result.calls[i]))) throw fault('INVALID_NATIVE_RESPONSE', 502);
    await start(meta);
    await emitHeld();
    if (route === 'chat') {
      const finishDelta = Array.isArray(meta.annotations) && meta.annotations.length ? { annotations: toChatAnnotations(meta.annotations) } : {};
      await sendChat(finishDelta, calls.length ? 'tool_calls' : 'stop');
      if (includeUsage) await sendWire('data: ' + JSON.stringify({ ...chatBase(), choices: [], usage: estimateUsage() }) + '\n\n');
      await sendWire('data: [DONE]\n\n');
    } else if (route === 'google') {
      if (googleTextOpen) {
        await sendGoogleEvent('content_block_stop', { index: googleBlockIndex });
        googleBlockIndex++;
        googleTextOpen = false;
      }
      await sendGoogleEvent('message_delta', {
        delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: estimateUsage().completion_tokens },
      });
      await sendGoogleEvent('message_stop', {});
    } else if (route === 'gemini') {
      await sendGeminiChunk(buildGeminiResponsePayload({ model: meta.model, content: '', calls: [], usage: estimateUsage() }, { includeFinish: true }));
      if (!geminiSse) await sendWire(']');
    } else {
      if (message && Array.isArray(meta.annotations) && meta.annotations.length) {
        message.content[0].annotations = meta.annotations.map(a => ({ ...a }));
      }
      await finishResponseItems();
      await sendResponse('response.completed', { response: response('completed') });
    }
    settled = true; stopKeepalive(); res.end();
  }
  async function interrupt(error) {
    stopDeferredHeaderTimer();
    if (settled || res.destroyed || res.writableEnded) { stopKeepalive(); return false; }
    if (error?.unverifiedOutput === true) {
      if (!started) { discard(); if (!keepaliveHeadersSent) { stopKeepalive(); return false; } }
      content = content.slice(0, publishedLength);
      bytes = Buffer.byteLength(content) + calls.reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call)), 0);
    }
    const partial = error?.partialResult ?? { ...meta, content, calls };
    const partialCalls = Array.isArray(partial.calls) ? partial.calls : [];
    const partialBytes = Buffer.byteLength(partial.content ?? '') +
      partialCalls.reduce((total, call) => total + Buffer.byteLength(JSON.stringify(call)), 0);
    if (partialCalls.length > 32 || partialBytes > MAX) {
      if (!started) discard();
      stopKeepalive();
      throw fault('RESPONSE_TOO_LARGE', 502);
    }
    if (!started && !keepaliveHeadersSent && error?.code === 'RESPONSE_TOO_LARGE') { discard(); stopKeepalive(); return false; }
    if (!started && !keepaliveHeadersSent && !partial.content?.length && !partialCalls.length) { stopKeepalive(); return false; }
    const detailStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
    const detail = {
      code: safeCode(error),
      status: detailStatus,
      type: detailStatus === 429 ? 'rate_limit_error' : detailStatus === 401 ? 'authentication_error' : detailStatus < 500 ? 'invalid_request_error' : 'server_error',
      message: safeCode(error),
    };
    res.incomplete = true;
    if (!stream) {
      settled = true;
      writeNonStream({ ...partial, calls: partialCalls, parallelToolCalls, incomplete: true, incompleteDetails: { reason: 'upstream_interrupted', code: detail.code }, outputError: detail });
      return true;
    }
    if (!started) await start(partial);
    // Decide from what the caller has actually seen, before the held prefix flushes.
    // Verified post-output upstream silence (HTTP 200, no reset/EOF, clean text) also
    // finishes cleanly with incomplete metadata instead of trapping callers in retries.
    const usable = publishedBytes >= PREFIX_BYTES || calls.length > 0 || (error?.postOutputIdleStall === true && content.trim().length > 0);
    // Deliver whatever the prefix gate was still holding before the error.
    await emitHeld();
    if (route === 'chat') {
      if (usable) {
        // End the turn on the content already delivered. A caller that treats an
        // unterminated stream as a failure deletes this text and silently asks the
        // model for the same answer again, so the partial is terminated as a
        // finished turn while still being marked incomplete.
        await sendWire('data: ' + JSON.stringify({ ...chatBase(),
          ...(meta.nativeSearch ? { native_search: meta.nativeSearch } : {}),
          choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
          incomplete: true, incomplete_details: { reason: 'upstream_interrupted', code: detail.code },
          ...(includeUsage ? { usage: estimateUsage() } : {}) }) + '\n\n');
        if (includeUsage) await sendWire('data: ' + JSON.stringify({ ...chatBase(), choices: [], usage: estimateUsage() }) + '\n\n');
        await sendWire('data: [DONE]\n\n');
      } else
        // Nothing usable was shown, so the explicit failure shape stays: an empty or
        // fragment-only turn may still be retried without splicing output.
        await sendWire('data: ' + JSON.stringify({ error: detail, incomplete: true }) + '\n\n');
    } else if (route === 'google') {
      if (googleTextOpen) {
        await sendGoogleEvent('content_block_stop', { index: googleBlockIndex });
        googleBlockIndex++;
        googleTextOpen = false;
      }
      const googleErrType = detailStatus === 429
        ? 'rate_limit_error'
        : detailStatus === 401
          ? 'authentication_error'
          : detailStatus < 500
            ? 'invalid_request_error'
            : 'api_error';
      await sendGoogleEvent('error', {
        error: {
          type: googleErrType,
          message: detail.message,
        },
      });
    } else if (route === 'gemini') {
      const geminiErr = buildGeminiErrorPayload(detail, detailStatus);
      await sendGeminiChunk({
        ...geminiErr,
        candidates: [
          {
            content: { role: 'model', parts: [] },
            finishReason: 'OTHER',
            index: 0,
          },
        ],
        modelVersion: meta.model,
      });
      if (!geminiSse) await sendWire(']');
    } else if (usable) {
      // Deliberate delivery-completion compatibility, matching Chat's stop branch.
      // Codex retries response.incomplete even after receiving usable text. Finish
      // only the delivered items/turn; keep the interruption explicit in extensions
      // and res.incomplete. This is not proof of full upstream generation completion.
      await finishResponseItems();
      await sendResponse('response.completed', { incomplete: true, response: response('completed', detail) });
    } else await sendResponse('response.incomplete', { response: response('incomplete', detail) });
    settled = true; stopKeepalive(); res.end(); return true;
  }
  // A retried attempt must not inherit a discarded fragment.
  function discard() {
    if (settled) return;
    stopKeepalive();
    delete meta.annotations;
    content = ''; calls = []; bytes = 0; publishedLength = 0; publishedBytes = 0; message = null; output.length = 0;
    googleBlockIndex = 0; googleTextOpen = false; geminiArrayFirst = true;
  }
  return { accept, complete, interrupt, discard, close: stopKeepalive,
    outputCommitState: () => ({ publishedBytes, toolCallCount: stream ? calls.length : 0 }),
    get started() { return started; },
    get keepaliveOnlyHeaders() { return keepaliveHeadersSent && !started; },
    get hasContent() { return content.length > 0 || calls.length > 0; },
    get callCount() { return calls.length; },
    get publishedBytes() { return publishedBytes; },
    // A fragment, not an empty or quota failure: some text arrived but the
    // caller has seen nothing usable, so replacing it splices nothing.
    get retryableShortfall() { return !settled && calls.length === 0 && publishedBytes === 0 && bytes > 0 && bytes < PREFIX_BYTES; } };
}
