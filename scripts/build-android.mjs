// 一键构建 Android APK（pnpm build:android 入口）
// 流程：web 构建 → capacitor sync → gradle 打包
// 用法：
//   pnpm build:android                # debug APK
//   pnpm build:android -- --release   # release APK（需已配置签名）
//   pnpm build:android -- --no-web    # 跳过 web 构建（只 sync + gradle）
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const androidDir = join(root, 'android');
const isWin = process.platform === 'win32';
const gradlew = join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');

const args = process.argv.slice(2);
const isRelease = args.includes('--release');
const skipWeb = args.includes('--no-web');

// 执行命令：Windows 下 .bat/.cmd 需经 cmd.exe，pnpm/npx 是 .cmd 也一样；
// 其余平台直接执行，避免 shell 拼接参数带来的转义/安全问题。
function run(cmd, argsList, opts = {}) {
  const display = `${cmd} ${argsList.join(' ')}`;
  console.log(`\n> ${display}`);
  const finalCmd = isWin ? 'cmd' : cmd;
  const finalArgs = isWin ? ['/d', '/s', '/c', cmd, ...argsList] : argsList;
  const r = spawnSync(finalCmd, finalArgs, {
    cwd: opts.cwd ?? root,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`\n[build-android] 步骤失败：${display}（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
  return r;
}

if (!skipWeb) {
  console.log('\n=== 1/3 Web 构建（tsc + vite build） ===');
  run('pnpm', ['build']);
}

console.log('\n=== 2/3 Capacitor 同步到 Android ===');
if (!existsSync(androidDir)) {
  run('npx', ['cap', 'add', 'android']);
}
run('npx', ['cap', 'sync', 'android']);

console.log(`\n=== 3/3 Gradle 打包 ${isRelease ? 'RELEASE' : 'DEBUG'} ===`);
const variant = isRelease ? 'assembleRelease' : 'assembleDebug';
run(gradlew, [variant], { cwd: androidDir });

const apkName = isRelease ? 'app-release.apk' : 'app-debug.apk';
const apkPath = join(androidDir, 'app', 'build', 'outputs', 'apk', isRelease ? 'release' : 'debug', apkName);
if (existsSync(apkPath)) {
  console.log('\n✅ 构建成功：');
  console.log(`   ${apkPath}`);
} else {
  console.error('\n⚠️ 构建完成但未找到 APK，请检查 gradle 输出。');
  process.exit(1);
}
