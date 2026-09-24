// electron-builder drops node_modules from extraResources, so the prepared agent bundle
// (see bundle-agent.mjs) is copied into the packaged app here, before installers are made.
const { cpSync, existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  const bundle = join(context.packager.projectDir, '.agent-bundle')
  if (!existsSync(join(bundle, 'node_modules'))) {
    throw new Error('Agent bundle is missing: run `npm run agent:bundle` before packaging')
  }
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  const target = join(resources, 'agent')
  rmSync(target, { recursive: true, force: true })
  cpSync(bundle, target, { recursive: true, dereference: true })
  console.log(`  • agent bundle copied  to=${target}`)
}
