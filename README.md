# @notrealstudio/backend-services

Хост сервисов плагинов nrchat (plugin-services-spec §4): Node-половина плагина — `service.ts` рядом с вьюшкой —
живёт в процессе бэкенда и доступна вьюшке через nr-ui-protocol (`services.call` / `services.stream`, протокол v1.11).

```ts
import { createServicesHost } from '@notrealstudio/backend-services'
import { createLocalBackend } from '@notrealstudio/backend-local'

const services = createServicesHost({
  root,                                            // корень пространства → meta.root
  plugins: { 'hello-service': 'services/hello-service.mjs' },   // id → модуль, относительный — от root
  context: (id) => buildScopes(layers).document,   // ctx сервиса; в exz — из @runz/runtime
})
const backend = createLocalBackend({ root, services })   // выставляет backend.services и capability services
```

## Контракт service.ts

```ts
import type { IContext } from '@notrealstudio/nrd'
import type { ServiceMeta } from '@notrealstudio/nr-ui-protocol/service'

export default async function (ctx: IContext, meta: ServiceMeta) {
  meta.on('echo', async (params) => params)                          // call
  meta.stream('tick', async (params, sink, signal) => {              // stream
    for (let i = 1; i <= 3 && !signal.aborted; i++) sink('tick', { i })
  })                                                                 // return — конец стрима
}
```

- `on` / `stream` — last-wins; регистрация после загрузки тоже видна в capability.
- `meta.root` — корень бэкенда, `meta.dataDir` — `~/.runz/data/nrchat-{pluginId}` (конвенция runz; хост его не
  создаёт), `meta.pluginDir` — каталог модуля, `meta.pluginId`.
- Default-экспорт обязан вернуться: всё долгое — в хендлерах. Состояние между вызовами — только на диске, хост вправе
  перезапустить сервис (restart-прозрачность).

## Семантика

| что | как |
|---|---|
| загрузка | в этом процессе, лениво — первый `call`/`stream`/`capability()`; один раз на плагин |
| упала загрузка (throw, нет default-функции) | warn; плагина нет в capability, вызовы — `not_supported`; не повторяется |
| незаявленный плагин/метод | `NotSupportedError`: у `call` — reject, у `stream` — reject первого `next()` |
| throw хендлера `call` | reject с его `message` и строковым `code` |
| throw хендлера `stream` | кадр `{name: 'error', payload: {message, code?}}`, затем конец |
| закрыть стрим (`break`, `return()`) | `signal` хендлера абортится сразу, висящий `next()` отпускается без ожидания кадра |
| `close()` | живые стримы абортятся и кончаются, дальше — `not_supported`, `capability()` — `{}` |

`createMemoryServices({ [id]: fn })` — тот же хост над функциями в памяти: фикстуры и e2e.

Idle-unload и изоляция (воркер на плагин) — вне v1: в exz процесс = окно. Понадобятся — меняется реализация
`createServicesHost`, не контракт: сервис не получает ни ссылки на бэкенд, ни общей с ним памяти.

## Разработка

```bash
npm test        # vitest: фикстуры .ts/.mjs в test/fixtures
npm run build   # tsc → dist
```
