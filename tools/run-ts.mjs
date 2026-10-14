/**
 * 通用「把任意 TS 文件打包后跑」的小工具。
 *
 *   node tools/run-ts.mjs tools/selftest.ts
 *   node tools/run-ts.mjs tools/scan.ts "C:\path\to\project"
 *
 * 主进程的业务逻辑不依赖 Electron，所以这样能在不启动界面的前提下调试/验证。
 */

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entryArg = process.argv[2]
if (!entryArg) {
  console.error('用法: node tools/run-ts.mjs <entry.ts> [args...]')
  process.exit(1)
}

const entry = path.resolve(process.cwd(), entryArg)
const outfile = path.join(root, '.ts-run-bundle.cjs')

/** 把 @shared/* @main/* 指到源码目录（与 electron.vite.config.ts 保持一致） */
const aliasPlugin = {
  name: 'src-alias',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(root, 'src', 'shared', args.path.slice('@shared/'.length) + '.ts')
    }))
    buildApi.onResolve({ filter: /^@main\// }, (args) => ({
      path: path.join(root, 'src', 'main', args.path.slice('@main/'.length) + '.ts')
    }))
  }
}

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile,
    external: ['electron'],
    plugins: [aliasPlugin],
    logLevel: 'warning'
  })

  const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(3)], {
    stdio: 'inherit',
    cwd: root
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(outfile, { force: true })
}
