// 静态资源自检：不跑插件，只查文件本身对不对。适合 CI 与提交前的一眼确认。
//
//   node tools/check-assets.mjs
//
// 查四件事：
//   1. icon.svg 是合法 SVG，且带 viewBox（侧边栏图标用得到）
//   2. locale/*.json 是合法 JSON，meta.title / meta.description 非空，中英齐全
//   3. 每个 locale 文件都被 package.json 的 exports/files 覆盖，不会被漏发
//   4. index.js / client.js 都能通过 node --check（语法即可，不加载）
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const pkg = JSON.parse(read('package.json'))

console.log('icon.svg')
const icon = read('icon.svg')
check('以 <svg 开头', /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(icon), icon.slice(0, 40))
check('带 viewBox（缩放不自适应会糊）', /viewBox\s*=/.test(icon))
check('是闭合的 <svg>', /<\/svg>\s*$/.test(icon.trimEnd()))
check('没有外部引用（<image href=http / <use href=http 之类）', !/href\s*=\s*["']https?:/i.test(icon))

console.log('\nlocale')
const localeFiles = readdirSync(join(ROOT, 'locale')).filter((name) => name.endsWith('.json')).sort()
check('至少 en / zh 两种语言', localeFiles.join(',') === 'en.json,zh.json', localeFiles.join(','))
const titles = new Set()
for (const file of localeFiles) {
  let parsed
  try {
    parsed = JSON.parse(read(`locale/${file}`))
  } catch (error) {
    check(`${file} 是合法 JSON`, false, String(error.message))
    continue
  }
  check(`${file} 是合法 JSON`, true)
  check(`${file} 有非空 meta.title`, typeof parsed.meta?.title === 'string' && parsed.meta.title.trim().length > 0,
    JSON.stringify(parsed.meta?.title))
  check(`${file} 有非空 meta.description`,
    typeof parsed.meta?.description === 'string' && parsed.meta.description.trim().length > 0)
  check(`${file} 没有多余字段`, Object.keys(parsed).join(',') === 'meta', Object.keys(parsed).join(','))
  titles.add(parsed.meta?.title)
}
check('各语言标题互不相同（不是复制没改）', titles.size === localeFiles.length, [...titles].join(' / '))

console.log('\npackage.json 覆盖')
check('exports 覆盖 locale/*.json', Boolean(pkg.exports?.['./locale/*.json']))
check('files 覆盖 locale/*.json', pkg.files?.includes('locale/*.json'), JSON.stringify(pkg.files))
check('files 不会把 test / tools / examples 发出去',
  !pkg.files?.some((f) => /^(test|tools|examples)\//.test(f)), JSON.stringify(pkg.files))

console.log('\n语法')
const node = process.execPath
for (const file of ['index.js', 'client.js']) {
  let ok = true
  let detail
  try {
    execFileSync(node, ['--check', join(ROOT, file)], { stdio: 'pipe' })
  } catch (error) {
    ok = false
    detail = String(error.stderr ?? error.message).split('\n').slice(0, 3).join(' ')
  }
  check(`${file} 通过 node --check`, ok, detail)
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
