import { basename } from 'node:path'
import { gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createBrowserGateway } from './services/analysis-service/src/api/browserGateway'

/** Generated evidence contains relative module names and byte counts only. */
function browserBuildMetrics(): Plugin {
  return {
    name: 'browser-build-metrics',
    apply: 'build',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk').map((chunk) => {
        const packages = new Map<string, number>()
        const modules: Array<{ name: string; renderedBytes: number }> = []
        for (const [id, module] of Object.entries(chunk.modules)) {
          const normalized = id.replace(/\\/g, '/')
          const dependency = normalized.split('/node_modules/').at(-1)
          const name = normalized.includes('/node_modules/') && dependency
            ? dependency.startsWith('@') ? dependency.split('/').slice(0, 2).join('/') : dependency.split('/')[0]
            : 'application'
          packages.set(name, (packages.get(name) ?? 0) + module.renderedLength)
          const relativeName = normalized.match(/\/(src|packages)\/.+$/)?.[0].slice(1)
          modules.push({ name: name === 'application' ? relativeName ?? basename(normalized).replace(/^\0/, '') : `${name}/${basename(normalized)}`, renderedBytes: module.renderedLength })
        }
        return {
          fileName: chunk.fileName, name: chunk.name, isEntry: chunk.isEntry,
          bytes: Buffer.byteLength(chunk.code), gzipBytes: gzipSync(chunk.code).byteLength,
          imports: chunk.imports, dynamicImports: chunk.dynamicImports,
          packages: [...packages].map(([name, renderedBytes]) => ({ name, renderedBytes })).sort((a, b) => b.renderedBytes - a.renderedBytes),
          largestModules: modules.sort((a, b) => b.renderedBytes - a.renderedBytes).slice(0, 20),
        }
      }).sort((a, b) => b.bytes - a.bytes)
      this.emitFile({ type: 'asset', fileName: 'build-metrics.json', source: JSON.stringify({ version: 1, chunks }, null, 2) + '\n' })
    } },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), browserBuildMetrics(), {
    name: 'local-analysis-gateway',
    configureServer(server) {
      const upstream = process.env.ANALYSIS_GATEWAY_UPSTREAM
      const gateway = createBrowserGateway(upstream ? {
        upstream, token: process.env.ANALYSIS_GATEWAY_TOKEN ?? '',
        tenantId: process.env.ANALYSIS_GATEWAY_TENANT ?? 'local-development',
        origins: (process.env.ANALYSIS_GATEWAY_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(','),
      } : undefined)
      server.middlewares.use('/api/analysis/v1', (request, response) => {
        request.url = `/api/analysis/v1${request.url ?? ''}`
        void gateway(request, response)
      })
    },
  }],
  server: { port: 5173, host: '127.0.0.1', strictPort: true },
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        // These leaf vendor graphs do not import application modules. Keep AI and extractors lazy.
        manualChunks(id) {
          const dependency = id.replace(/\\/g, '/').split('/node_modules/').at(-1)?.split('/')[0]
          if (dependency === 'react' || dependency === 'react-dom' || dependency === 'scheduler') return 'vendor-react'
          if (dependency === 'dexie') return 'vendor-storage'
          if (dependency === 'zod') return 'vendor-validation'
        },
      },
    },
  },
})
