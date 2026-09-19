import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    // file:-зависимости — симлинки на соседние репы nrlib.
    preserveSymlinks: true,
  },
})
