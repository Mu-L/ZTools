import { describe, expect, it, vi } from 'vitest'
import type OpenAI from 'openai'
import {
  normalizeAiChatFailure,
  resolveAiReasoningPolicy,
  streamSingleAiChat,
  streamSingleAiProtocolChat,
  type AiChatEvent
} from '../../src/main/core/aiChatTransport'

/**
 * 用确定的 SSE 分片创建最小 OpenAI 客户端替身。
 * @param chunks 按接收顺序返回的 Chat Completions 分片
 * @returns 可传给单轮传输函数的客户端及请求记录
 */
function createStreamingClient(chunks: Array<Record<string, unknown>>): {
  client: OpenAI
  create: ReturnType<typeof vi.fn>
} {
  const create = vi.fn().mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    }
  })
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    create
  }
}

describe('aiChatTransport', () => {
  it('streams reasoning, content and usage while closing reasoning before content', async () => {
    const { client, create } = createStreamingClient([
      { choices: [{ delta: { reasoning_content: '先分析' }, finish_reason: null }] },
      { choices: [{ delta: { content: '答案' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
      }
    ])
    const events: AiChatEvent[] = []
    const result = await streamSingleAiChat(
      client,
      'gpt-5.6-sol',
      {
        messages: [{ role: 'user', content: '测试' }],
        reasoningEffort: 'high',
        modelReasoning: {
          protocol: 'auto',
          efforts: { high: 'high' },
          responseField: 'auto'
        }
      },
      new AbortController().signal,
      (event) => events.push(event)
    )

    expect(events.map((event) => event.type)).toEqual([
      'reasoning',
      'reasoning_end',
      'content',
      'usage'
    ])
    expect(result).toMatchObject({
      content: '答案',
      reasoning_content: '先分析',
      finish_reason: 'stop',
      usage: { total_tokens: 17 }
    })
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
      stream_options: { include_usage: true }
    })
  })

  it('returns complete tool calls without executing them', async () => {
    const { client } = createStreamingClient([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-one',
                  function: { name: 'read_file', arguments: '{"path"' }
                }
              ]
            },
            finish_reason: null
          }
        ]
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] },
            finish_reason: 'tool_calls'
          }
        ]
      }
    ])
    const result = await streamSingleAiChat(
      client,
      'model-a',
      {
        messages: [{ role: 'user', content: '读取文件' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: '读取文件',
              parameters: { type: 'object', properties: { path: { type: 'string' } } }
            }
          }
        ]
      },
      new AbortController().signal,
      () => {}
    )

    expect(result.finish_reason).toBe('tool_calls')
    expect(result.tool_calls).toEqual([
      {
        id: 'call-one',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' }
      }
    ])
  })

  it('rejects a stream that closes before finish_reason', async () => {
    const { client } = createStreamingClient([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'partial', function: { name: 'shell', arguments: '{"command"' } }
              ]
            },
            finish_reason: null
          }
        ]
      }
    ])

    await expect(
      streamSingleAiChat(
        client,
        'model-a',
        { messages: [{ role: 'user', content: '执行命令' }] },
        new AbortController().signal,
        () => {}
      )
    ).rejects.toMatchObject({ normalizedCode: 'STREAM_CLOSED' })
  })

  it('maps provider reasoning protocols and structured server errors', () => {
    expect(
      resolveAiReasoningPolicy(
        'deepseek-v4-flash',
        { protocol: 'auto', efforts: { off: null, high: 'high' }, responseField: 'auto' },
        'high'
      ).request
    ).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    expect(
      resolveAiReasoningPolicy(
        'gpt-5.6-sol',
        { protocol: 'auto', efforts: { xhigh: 'ultra' }, responseField: 'auto' },
        'xhigh'
      ).request
    ).toEqual({ reasoning_effort: 'ultra' })
    expect(
      resolveAiReasoningPolicy('gpt-5.6-sol', {
        protocol: 'openai-compatible',
        efforts: { off: 'none' },
        defaultEffort: 'off',
        responseField: 'auto'
      }).request
    ).toEqual({ reasoning_effort: 'none' })
    expect(
      resolveAiReasoningPolicy('gpt-5.6-sol', {
        protocol: 'openai-compatible',
        efforts: { off: null },
        defaultEffort: 'off',
        responseField: 'auto'
      }).request
    ).toEqual({})
    expect(
      resolveAiReasoningPolicy(
        'deepseek-v4-flash',
        { protocol: 'deepseek', efforts: { off: null }, responseField: 'auto' },
        'off'
      ).request
    ).toEqual({ thinking: { type: 'disabled' } })
    expect(resolveAiReasoningPolicy('gpt-5.6-sol', undefined).request).toEqual({})
    let unsupportedError: unknown
    try {
      resolveAiReasoningPolicy(
        'gpt-5.6-sol',
        { protocol: 'auto', efforts: { high: 'high' }, responseField: 'auto' },
        'max'
      )
    } catch (error) {
      unsupportedError = error
    }
    expect(unsupportedError).toMatchObject({
      normalizedCode: 'UNSUPPORTED_REASONING_EFFORT',
      message: expect.stringContaining('不支持推理强度')
    })
    expect(normalizeAiChatFailure(new Error('Upstream request failed'))).toMatchObject({
      code: 'SERVER',
      message: 'Upstream request failed'
    })
  })

  it('bridges protocol adapters to ordered aiChat events without executing tools', async () => {
    const events: AiChatEvent[] = []
    const adapter = {
      stream: vi.fn(async (_input, _signal, onDelta) => {
        onDelta({ reasoningContent: '先分析' })
        onDelta({ content: '答案' })
        return {
          content: '答案',
          reasoningContent: '先分析',
          toolCalls: [
            {
              id: 'call-protocol',
              type: 'function' as const,
              function: { name: 'lookup', arguments: '{"id":1}' }
            }
          ]
        }
      })
    }

    const result = await streamSingleAiProtocolChat(
      adapter,
      'protocol-model',
      {
        messages: [{ role: 'user', content: '测试' }],
        temperature: 0.7,
        maxTokens: 2048,
        toolChoice: 'required'
      },
      new AbortController().signal,
      (event) => events.push(event)
    )

    expect(events).toEqual([
      { type: 'reasoning', delta: '先分析' },
      { type: 'reasoning_end' },
      { type: 'content', delta: '答案' },
      {
        type: 'tool_call',
        index: 0,
        id: 'call-protocol',
        name: 'lookup',
        argumentsDelta: '{"id":1}'
      }
    ])
    expect(adapter.stream.mock.calls[0][0]).toMatchObject({
      model: 'protocol-model',
      temperature: 0.7,
      maxTokens: 2048,
      toolChoice: 'required'
    })
    expect(result).toMatchObject({
      content: '答案',
      reasoning_content: '先分析',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'call-protocol' }]
    })
  })
})
