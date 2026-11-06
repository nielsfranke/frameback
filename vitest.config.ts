import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Unit tests run everywhere. Integration tests need a migrated Postgres:
//   TEST_DATABASE_URL=postgresql://... npm test
// (CI provides one; locally see tests/integration/README.md)
const testDb = process.env.TEST_DATABASE_URL

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] },
      },
      ...(testDb
        ? [{
            extends: true,
            test: {
              name: 'integration',
              include: ['tests/integration/**/*.test.ts'],
              env: { DATABASE_URL: testDb },
              // one shared database: run files sequentially
              fileParallelism: false,
            },
          }]
        : []),
    ],
  },
})
