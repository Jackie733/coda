import { parsePatchArguments, runPatchCli } from "./patch-cli.js";
import { visibleControls } from "./readonly-cli.js";
import { safeCliErrorText } from "./safe-cli-error.js";

try {
  const options = parsePatchArguments(process.argv.slice(2));
  process.exitCode = await runPatchCli(options);
} catch (error) {
  const message = safeCliErrorText(error, "未知参数错误；为保护凭据，错误详情已隐藏。");
  process.stderr.write(`用法错误：${visibleControls(message)}\n`);
  process.stderr.write('示例：npm run patch -- --plan "修复输入校验" --file src/app.ts\n');
  process.exitCode = 2;
}
