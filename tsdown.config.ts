/**
 * Standalone build config for the dsh-feishu-bot plugin.
 *
 * Uses the vendored client-bundle preset (build/tsdown.client.ts, copied from
 * the dsh-web-ui family repo): node-half lib/ (host bot engine + routes +
 * tools) plus the browser bundle lib/client.js (closure-factory artifact for
 * the GUI's __ModuleLoader__, CSS Modules inlined with auto-injected
 * <style data-plugin>). The client entry is auto-detected at src/client/index.ts.
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@wangsan71/dsh-feishu-bot', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-default-model',
    '@deepseek-ai/dsh-fs',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-workspace',
  ],
})
