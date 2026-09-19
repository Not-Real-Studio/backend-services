// Фикстура: сервис на нативном TS ноды (dev-режим sidecar).
interface Meta {
  pluginId: string
  root: string
  dataDir: string
  pluginDir: string
  on(method: string, handler: (params: unknown) => unknown): void
  stream(
    method: string,
    handler: (params: unknown, sink: (name: string, payload?: unknown) => void, signal: AbortSignal) => unknown,
  ): void
}

export default async function (ctx: unknown, meta: Meta): Promise<void> {
  meta.on('echo', (params) => params)
  meta.on('meta', () => ({ pluginId: meta.pluginId, root: meta.root, dataDir: meta.dataDir, pluginDir: meta.pluginDir, ctx }))
  meta.on('fail', () => {
    throw Object.assign(new Error('boom'), { code: 'bad_request' })
  })
  meta.stream('tick', async (params, sink, signal) => {
    const n = (params as { n?: number } | undefined)?.n ?? 3
    for (let i = 1; i <= n; i++) {
      if (signal.aborted) return
      sink('tick', { i })
      await new Promise((r) => setTimeout(r, 5))
    }
  })
}
