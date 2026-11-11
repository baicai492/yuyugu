// 安装 Chrome Native Messaging 宿主 + 启动脚本，让 GUI 的「启动主程序」按钮能用。
//
// 要做两件事：
//   1. 生成一个 .bat 包装器（Chrome 在 Windows 上只能执行 .exe/.bat）
//   2. 把宿主清单注册到注册表 HKCU\Software\Google\Chrome\NativeMessagingHosts
//
// 用法：node scripts/install-host.mjs [--uninstall]
//       node scripts/install-host.mjs --print   （只打印将要做什么，不写注册表）
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const HOST_NAME = 'com.baicai492.yuyugu'
const uninstall = process.argv.includes('--uninstall')
const printOnly = process.argv.includes('--print')

const HOST_DIR = resolve(ROOT, 'native')
const HOST_MJS = resolve(HOST_DIR, 'yuyugu-host.mjs')
const HOST_BAT = resolve(HOST_DIR, 'yuyugu-host.bat')
const MANIFEST = resolve(HOST_DIR, `${HOST_NAME}.json`)

function regKey(chrome = true) {
  const base = chrome ? 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts' : 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts'
  return `${base}\\${HOST_NAME}`
}

function writeManifest() {
  // Chrome 要求 allowed_origins 里写扩展 ID。
  // 未打包扩展的 ID 由路径决定，安装后从 chrome://extensions 复制。
  // 这里先留空，用脚本的 --ext-id 参数补。
  const extId = process.argv.find((a) => a.startsWith('--ext-id='))?.split('=')[1] || ''
  const manifest = {
    name: HOST_NAME,
    description: '鱼鱼谷托管：启动本地 Node 主程序',
    path: HOST_BAT,
    type: 'stdio',
    allowed_origins: extId ? [`chrome-extension://${extId}/`] : [],
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8')
  return { manifest, extId }
}

function writeBat() {
  // Chrome 启动宿主时不会带工作目录，所以 .bat 里要自己 cd
  const bat = `@echo off\r\nchcp 65001 >nul\r\ncd /d "${ROOT}"\r\n"${process.execPath}" "${HOST_MJS}" %*\r\n`
  writeFileSync(HOST_BAT, bat, 'utf8')
}

if (uninstall) {
  for (const chrome of [true, false]) {
    try {
      execFileSync('reg', ['delete', regKey(chrome), '/f'], { stdio: 'ignore' })
      console.log('已删除注册表项：' + regKey(chrome))
    } catch {}
  }
  try { rmSync(MANIFEST) } catch {}
  try { rmSync(HOST_BAT) } catch {}
  console.log('卸载完成')
  process.exit(0)
}

if (!existsSync(HOST_DIR)) mkdirSync(HOST_DIR, { recursive: true })
writeBat()
const { manifest, extId } = writeManifest()

console.log('已生成：')
console.log('  ' + HOST_BAT)
console.log('  ' + MANIFEST)

if (!extId) {
  console.log('\n⚠ 还没有扩展 ID。请：')
  console.log('  1. Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 gui/ 目录')
  console.log('  2. 复制显示的扩展 ID')
  console.log('  3. 重新运行：node scripts/install-host.mjs --ext-id=<那个ID>')
  process.exit(2)
}

console.log('\n扩展 ID：' + extId)

const regValue = regKey(true)
const edgeValue = regKey(false)
const cmdParts = ['add', regValue, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f']
if (printOnly) {
  console.log('将执行：reg ' + cmdParts.join(' '))
  console.log('以及：reg ' + ['add', edgeValue, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f'].join(' '))
  process.exit(0)
}

try {
  execFileSync('reg', cmdParts, { stdio: 'inherit' })
  console.log('✓ 已注册到 Chrome')
} catch (e) {
  console.error('✗ 注册 Chrome 失败：' + e.message)
}
try {
  execFileSync('reg', ['add', edgeValue, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f'], { stdio: 'inherit' })
  console.log('✓ 已注册到 Edge')
} catch (e) {
  console.error('✗ 注册 Edge 失败：' + e.message)
}

// 自检
try {
  const out = execFileSync(process.execPath, [HOST_MJS, '--self-test'], { encoding: 'utf8', timeout: 5000 })
  console.log('\n宿主自检：' + out.trim())
} catch (e) {
  console.error('\n宿主自检失败：' + e.message)
}

console.log('\n完成。现在打开插件，点「启动主程序」即可。')
