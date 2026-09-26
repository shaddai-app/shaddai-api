import { defineConfig } from 'vitest/config';

// Tests unitarios: sin base de datos (corren en el job `check` de CI).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
    setupFiles: ['test/unit/setup.ts'],
  },
});
