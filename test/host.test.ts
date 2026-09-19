import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { NotSupportedError } from '@notrealstudio/nr-ui-protocol'
import type { ServiceEvent } from '@notrealstudio/nr-ui-protocol'
import { createMemoryServices, createServicesHost } from '../src/index.js'
import type { ServiceMeta } from '../src/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function collect(iter: AsyncIterable<ServiceEvent>): Promise<ServiceEvent[]> {
  const out: ServiceEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

describe('createServicesHost: модули с диска', () => {
  function host(warnings: string[] = []) {
    return createServicesHost({
      root: FIXTURES,
      plugins: { hello: 'hello/service.ts', broken: 'broken/service.mjs', plain: 'plain/service.mjs' },
      warn: (m) => warnings.push(m),
      context: (id) => ({ plugin: id }),
    })
  }

  it('capability: только загрузившиеся, с методами и стримами', async () => {
    const warnings: string[] = []
    const h = host(warnings)
    expect(await h.capability()).toEqual({ hello: { methods: ['echo', 'meta', 'fail'], streams: ['tick'] } })
    expect(warnings).toHaveLength(2)
    expect(warnings.join('\n')).toMatch(/broken.*не собрался/)
    expect(warnings.join('\n')).toMatch(/plain.*default/)
  })

  it('call: echo возвращает params; meta — корень, каталоги, ctx', async () => {
    const h = host()
    expect(await h.call('hello', 'echo', { a: [1, 'два'] })).toEqual({ a: [1, 'два'] })
    expect(await h.call('hello', 'meta')).toEqual({
      pluginId: 'hello',
      root: FIXTURES,
      dataDir: join(homedir(), '.runz', 'data', 'nrchat-hello'),
      pluginDir: join(FIXTURES, 'hello'),
      ctx: { plugin: 'hello' },
    })
  })

  it('ошибки: хендлер — его message и code; незаявленное — not_supported', async () => {
    const warnings: string[] = []
    const h = host(warnings)
    await expect(h.call('hello', 'fail')).rejects.toMatchObject({ message: 'boom', code: 'bad_request' })
    await expect(h.call('hello', 'nope')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(h.call('ghost', 'echo')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(h.call('broken', 'echo')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(h.call('broken', 'echo')).rejects.toBeInstanceOf(NotSupportedError)
    expect(warnings).toHaveLength(1) // упавшая загрузка не повторяется
  })

  it('stream: 3 кадра и конец; not_supported — reject первого next()', async () => {
    const h = host()
    expect(await collect(h.stream('hello', 'tick'))).toEqual([
      { name: 'tick', payload: { i: 1 } },
      { name: 'tick', payload: { i: 2 } },
      { name: 'tick', payload: { i: 3 } },
    ])
    await expect(collect(h.stream('hello', 'echo'))).rejects.toBeInstanceOf(NotSupportedError)
    await expect(collect(h.stream('broken', 'tick'))).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('ленивость: модуль грузится при первом вызове, один раз', async () => {
    const loaded: string[] = []
    const h = createServicesHost({
      root: FIXTURES,
      plugins: { hello: 'hello/service.ts' },
      importModule: async (file) => {
        loaded.push(file)
        return import(file)
      },
    })
    expect(loaded).toEqual([])
    await Promise.all([h.call('hello', 'echo', 1), h.call('hello', 'echo', 2), h.capability()])
    expect(loaded).toEqual([join(FIXTURES, 'hello', 'service.ts')])
  })
})

describe('createMemoryServices: семантика хоста', () => {
  it('last-wins и регистрация после загрузки видна', async () => {
    let later: ServiceMeta | undefined
    const h = createMemoryServices({
      p: (_ctx, meta) => {
        meta.on('m', () => 1)
        meta.on('m', () => 2)
        later = meta
      },
    })
    expect(await h.call('p', 'm')).toBe(2)
    later!.stream('s', (_a, sink) => sink('x'))
    expect(await h.capability()).toEqual({ p: { methods: ['m'], streams: ['s'] } })
  })

  it('throw стрима после кадров — кадр error и конец', async () => {
    const h = createMemoryServices({
      p: (_ctx, meta) => {
        meta.stream('s', async (_a, sink) => {
          sink('one', 1)
          throw Object.assign(new Error('сломалось'), { code: 'conflict' })
        })
      },
    })
    expect(await collect(h.stream('p', 's'))).toEqual([
      { name: 'one', payload: 1 },
      { name: 'error', payload: { message: 'сломалось', code: 'conflict' } },
    ])
  })

  it('break посреди стрима — сервис видит abort; молчащий стрим закрывается сразу', async () => {
    let aborted = 0
    const h = createMemoryServices({
      p: (_ctx, meta) => {
        meta.stream('forever', async (_a, sink, signal) => {
          sink('first')
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          aborted++
          sink('after-abort') // no-op
        })
        meta.stream('silent', async (_a, _sink, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          aborted++
        })
      },
    })
    for await (const e of h.stream('p', 'forever')) {
      expect(e).toEqual({ name: 'first' })
      break
    }
    await tick()
    expect(aborted).toBe(1)

    const it = h.stream('p', 'silent')[Symbol.asyncIterator]()
    const pending = it.next()
    await tick()
    await it.return!()
    expect(await pending).toEqual({ value: undefined, done: true })
    await tick()
    expect(aborted).toBe(2)
  })

  it('close(): живые стримы абортятся и кончаются, дальше — not_supported и пустая capability', async () => {
    let aborted = false
    const h = createMemoryServices({
      p: (_ctx, meta) => {
        meta.on('m', () => 1)
        meta.stream('s', async (_a, _sink, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          aborted = true
        })
      },
    })
    const it = h.stream('p', 's')[Symbol.asyncIterator]()
    const pending = it.next()
    await tick()
    await h.close()
    expect(await pending).toEqual({ value: undefined, done: true })
    await tick()
    expect(aborted).toBe(true)
    await expect(h.call('p', 'm')).rejects.toBeInstanceOf(NotSupportedError)
    expect(await h.capability()).toEqual({})
  })

  it('упавший default-экспорт — не в capability, вызовы not_supported', async () => {
    const warnings: string[] = []
    const h = createMemoryServices(
      {
        bad: () => {
          throw new Error('x')
        },
        good: (_c, meta) => meta.on('ok', () => 'ok'),
      },
      { warn: (m) => warnings.push(m) },
    )
    expect(await h.capability()).toEqual({ good: { methods: ['ok'], streams: [] } })
    await expect(h.call('bad', 'ok')).rejects.toBeInstanceOf(NotSupportedError)
    expect(warnings).toHaveLength(1)
  })

  it('ключи прототипа — не плагины', async () => {
    const h = createMemoryServices({})
    await expect(h.call('constructor', 'x')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(h.call('__proto__', 'x')).rejects.toBeInstanceOf(NotSupportedError)
  })
})
