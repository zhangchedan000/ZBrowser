import { build } from 'esbuild'

await build({
  entryPoints: ['src/main/mcp-stdio-node-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'out/mcp-stdio.cjs',
  logLevel: 'info'
})
