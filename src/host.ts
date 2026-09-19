/**
 * createServicesHost — Node-половины плагинов nrchat в процессе бэкенда
 * (plugin-services-spec §4).
 *
 * Каждый плагин — модуль `service.ts|.mjs` с default-экспортом
 * `(ctx, meta: ServiceMeta)`: он регистрирует `meta.on` / `meta.stream`, хост
 * отдаёт их как `ServicesOps` и capability `services`. Модуль грузится в ЭТОМ
 * процессе (не спавнится), лениво — при первом вызове или `capability()`.
 * Упавшая загрузка — warn, плагин пропадает из capability, его вызовы —
 * `not_supported`.
 *
 * Хост не даёт сервису ни ссылки на бэкенд, ни общей с ним памяти — только
 * `ctx`, `meta` и провод. Изоляция (воркер на плагин, idle-unload) меняет
 * реализацию этого файла, не контракт.
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NotSupportedError, serviceErrorEvent } from '@notrealstudio/nr-ui-protocol'
import type { ServiceEvent, ServicesCapability, ServicesHost } from '@notrealstudio/nr-ui-protocol'
import type {
  ServiceCallHandler,
  ServiceFn,
  ServiceMeta,
  ServiceStreamHandler,
} from '@notrealstudio/nr-ui-protocol/service'

// ────────────────────────────────────────────────────────────────────────────
// Опции
// ────────────────────────────────────────────────────────────────────────────

/** Общие опции обеих фабрик. */
export interface ServicesBaseOpts {
  /** Корень пространства — `meta.root`. Default `process.cwd()`. */
  root?: string
  /**
   * `ctx` сервиса плагина. В exz — `buildScopes(...).document` из
   * `@runz/runtime`, как у appz; хост runz не знает. Default — `{}`.
   */
  context?: (pluginId: string) => unknown | Promise<unknown>
  /** `meta.dataDir`. Default — конвенция runz: `~/.runz/data/nrchat-{pluginId}`. */
  dataDir?: (pluginId: string) => string
  /** Варнинги (упавшая загрузка). Default — stderr. */
  warn?: (message: string) => void
}

export interface ServicesHostOpts extends ServicesBaseOpts {
  /** `plugin.id` → путь к `service.ts|.mjs` (относительный — от `root`). */
  plugins: Record<string, string>
  /** Загрузчик модуля. Default — `import(fileURL)`: `.ts` — нативным TS ноды. */
  importModule?: (file: string) => Promise<unknown>
}

/** Опции {@link createMemoryServices}: сервисы — функции в памяти, без загрузки. */
export interface MemoryServicesOpts extends ServicesBaseOpts {
  /** `meta.pluginDir`. Default — `root`. */
  pluginDir?: (pluginId: string) => string
}

/** Префикс имени данных по конвенции runz (`nrchat-{pluginId}`). */
export const SERVICE_DATA_PREFIX = 'nrchat-'

// ────────────────────────────────────────────────────────────────────────────
// Фабрики
// ────────────────────────────────────────────────────────────────────────────

export function createServicesHost(opts: ServicesHostOpts): ServicesHost {
  const root = resolve(opts.root ?? process.cwd())
  const importModule = opts.importModule ?? ((file: string) => import(pathToFileURL(file).href))
  const sources: Record<string, Source> = {}
  for (const [id, path] of Object.entries(opts.plugins)) {
    const file = resolve(root, path)
    sources[id] = {
      pluginDir: dirname(file),
      async load() {
        const mod = (await importModule(file)) as { default?: unknown } | null
        const fn = mod?.default
        if (typeof fn !== 'function') throw new Error(`${file}: нет default-экспорта-функции`)
        return fn as ServiceFn
      },
    }
  }
  return createHost(root, sources, opts)
}

/**
 * Хост над функциями в памяти — фикстуры, тесты, e2e: та же семантика, что
 * у {@link createServicesHost} (ленивый вызов, last-wins, abort, кадр error),
 * только без файлов.
 */
export function createMemoryServices(services: Record<string, ServiceFn>, opts: MemoryServicesOpts = {}): ServicesHost {
  const root = resolve(opts.root ?? process.cwd())
  const sources: Record<string, Source> = {}
  for (const [id, fn] of Object.entries(services)) {
    sources[id] = { pluginDir: opts.pluginDir?.(id) ?? root, load: async () => fn }
  }
  return createHost(root, sources, opts)
}

// ────────────────────────────────────────────────────────────────────────────
// Ядро
// ────────────────────────────────────────────────────────────────────────────

interface Source {
  pluginDir: string
  load(): Promise<ServiceFn>
}

/** Загруженный сервис: зарегистрированное им. Мапы живые — регистрация после загрузки видна. */
interface Loaded {
  calls: Map<string, ServiceCallHandler>
  streams: Map<string, ServiceStreamHandler>
}

function createHost(root: string, sources: Record<string, Source>, opts: ServicesBaseOpts): ServicesHost {
  const warn = opts.warn ?? ((message: string) => void process.stderr.write(`backend-services: ${message}\n`))
  const dataDirOf = opts.dataDir ?? ((id: string) => join(homedir(), '.runz', 'data', `${SERVICE_DATA_PREFIX}${id}`))
  const loads = new Map<string, Promise<Loaded | null>>()
  /** Живые стримы: close() их абортит. */
  const live = new Set<() => void>()
  let closed = false

  function load(id: string): Promise<Loaded | null> {
    let pending = loads.get(id)
    if (!pending) {
      pending = start(id)
      loads.set(id, pending)
    }
    return pending
  }

  async function start(id: string): Promise<Loaded | null> {
    const source = sources[id]!
    const loaded: Loaded = { calls: new Map(), streams: new Map() }
    const meta: ServiceMeta = {
      pluginId: id,
      root,
      dataDir: dataDirOf(id),
      pluginDir: source.pluginDir,
      on(method, handler) {
        checkRegistration('on', method, handler)
        loaded.calls.set(method, handler)
      },
      stream(method, handler) {
        checkRegistration('stream', method, handler)
        loaded.streams.set(method, handler)
      },
    }
    try {
      const fn = await source.load()
      const ctx = opts.context ? await opts.context(id) : {}
      await fn(ctx, meta)
      return loaded
    } catch (err) {
      warn(`сервис плагина "${id}" не загрузился: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** Загруженный сервис или not_supported: закрыт хост, нет плагина, упал при загрузке. */
  async function service(id: string, op: string): Promise<Loaded> {
    if (closed) throw new NotSupportedError(op, 'Services host is closed')
    if (typeof id !== 'string' || !Object.hasOwn(sources, id)) {
      throw new NotSupportedError(op, `Plugin "${String(id)}" has no service`)
    }
    const loaded = await load(id)
    if (!loaded) throw new NotSupportedError(op, `Service of plugin "${id}" failed to load`)
    if (closed) throw new NotSupportedError(op, 'Services host is closed')
    return loaded
  }

  return {
    async capability(): Promise<ServicesCapability> {
      const out: ServicesCapability = {}
      if (closed) return out
      const ids = Object.keys(sources)
      const loaded = await Promise.all(ids.map((id) => load(id)))
      ids.forEach((id, i) => {
        const l = loaded[i]
        if (l) out[id] = { methods: [...l.calls.keys()], streams: [...l.streams.keys()] }
      })
      return out
    },

    async call(plugin: string, method: string, args?: unknown): Promise<unknown> {
      const loaded = await service(plugin, 'services.call')
      const handler = typeof method === 'string' ? loaded.calls.get(method) : undefined
      if (!handler) throw new NotSupportedError('services.call', `Service "${plugin}" has no method "${String(method)}"`)
      return handler(args)
    },

    stream(plugin: string, method: string, args?: unknown): AsyncIterable<ServiceEvent> {
      return {
        [Symbol.asyncIterator]: () =>
          createStreamIterator(async () => {
            const loaded = await service(plugin, 'services.stream')
            const handler = typeof method === 'string' ? loaded.streams.get(method) : undefined
            if (!handler) {
              throw new NotSupportedError('services.stream', `Service "${plugin}" has no stream "${String(method)}"`)
            }
            return (sink, signal) => handler(args, sink, signal)
          }, live),
      }
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      for (const abort of [...live]) abort()
      live.clear()
    },
  }
}

function checkRegistration(kind: string, method: unknown, handler: unknown): void {
  if (typeof method !== 'string' || method === '') throw new TypeError(`meta.${kind}: method must be a non-empty string`)
  if (typeof handler !== 'function') throw new TypeError(`meta.${kind}("${method}"): handler must be a function`)
}

// ────────────────────────────────────────────────────────────────────────────
// Стрим: итератор, который закрывается сразу
// ────────────────────────────────────────────────────────────────────────────

type Runner = (sink: (name: string, payload?: unknown) => void, signal: AbortSignal) => unknown

/**
 * Итератор стрима. Не async-генератор: у генератора `return()` встаёт в
 * очередь за висящим `next()`, и молчащий стрим нельзя было бы закрыть, не
 * дождавшись кадра. Здесь `return()` абортит хендлер и отпускает `next()` сразу.
 *
 * Первый `next()` открывает стрим: `open()` бросил (`not_supported`) — reject
 * этого `next()`, кадров нет. Дальше throw хендлера — кадр `error` и конец.
 */
function createStreamIterator(open: () => Promise<Runner>, live: Set<() => void>): AsyncIterator<ServiceEvent> {
  const queue: ServiceEvent[] = []
  let waiter: { resolve: (r: IteratorResult<ServiceEvent>) => void; reject: (e: unknown) => void } | undefined
  let opening: Promise<void> | undefined
  let finished = false
  const ac = new AbortController()

  const abort = () => {
    if (!ac.signal.aborted) ac.abort()
    finish()
  }

  function finish(): void {
    if (finished) return
    finished = true
    live.delete(abort)
    flush()
  }

  function flush(): void {
    if (!waiter) return
    if (queue.length > 0) {
      const w = waiter
      waiter = undefined
      w.resolve({ value: queue.shift()!, done: false })
    } else if (finished) {
      const w = waiter
      waiter = undefined
      w.resolve({ value: undefined, done: true })
    }
  }

  const sink = (name: string, payload?: unknown): void => {
    if (typeof name !== 'string' || name === '') throw new TypeError('sink: name must be a non-empty string')
    if (finished) return
    queue.push(payload === undefined ? { name } : { name, payload })
    flush()
  }

  function begin(): Promise<void> {
    live.add(abort)
    return open().then(
      (run) => {
        if (finished) return
        Promise.resolve()
          .then(() => run(sink, ac.signal))
          .then(
            () => finish(),
            (err: unknown) => {
              if (!finished && !ac.signal.aborted) queue.push(serviceErrorEvent(err))
              finish()
            },
          )
      },
      (err: unknown) => {
        live.delete(abort)
        finished = true
        queue.length = 0
        throw err
      },
    )
  }

  return {
    async next(): Promise<IteratorResult<ServiceEvent>> {
      if (!opening) {
        opening = begin()
        await opening // not_supported — reject первого next()
      }
      if (queue.length > 0) return { value: queue.shift()!, done: false }
      if (finished) return { value: undefined, done: true }
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject }
      })
    },

    async return(): Promise<IteratorResult<ServiceEvent>> {
      queue.length = 0
      abort()
      return { value: undefined, done: true }
    },
  }
}
