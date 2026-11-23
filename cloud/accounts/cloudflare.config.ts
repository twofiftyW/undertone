import { bindings, defineConfig, triggers } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'undertone-accounts',
    entrypoint: './worker.js',
    compatibilityDate: '2026-11-23',
    env: {
      DB: bindings.d1({ name: 'undertone-accounts', id: process.env.UNDERTONE_D1_ID || undefined }),
      GITHUB_CLIENT_ID: bindings.text(process.env.UNDERTONE_GITHUB_CLIENT_ID || ''),
      OWNER_GITHUB_ID: bindings.text(process.env.UNDERTONE_OWNER_GITHUB_ID || ''),
      SIGN_IN_LIMIT: bindings.rateLimit({ namespace: '17141', simple: { limit: 12, period: 60 } })
    },
    triggers: [triggers.scheduled({ schedule: '17 4 * * *' })],
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: true, headSamplingRate: 0.01 }
    }
  }
});
