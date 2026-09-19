/**
 * @notrealstudio/backend-services — хост сервисов плагинов nrchat
 * (plugin-services-spec §4).
 *
 * ```ts
 * const services = createServicesHost({ root, plugins: { translate: 'services/translate.mjs' } })
 * const backend = createLocalBackend({ root, services })
 * ```
 *
 * Бэкенду отдаётся композицией: он выставляет `services` и заявляет
 * `capabilities().services = await services.capability()`. Транспорта не знает.
 */

export { createServicesHost, createMemoryServices, SERVICE_DATA_PREFIX } from './host.js'
export type { ServicesBaseOpts, ServicesHostOpts, MemoryServicesOpts } from './host.js'
export type { ServicesHost, ServicesOps, ServiceEvent, ServicesCapability } from '@notrealstudio/nr-ui-protocol'
export type {
  ServiceCallHandler,
  ServiceFn,
  ServiceMeta,
  ServiceSink,
  ServiceStreamHandler,
} from '@notrealstudio/nr-ui-protocol/service'
