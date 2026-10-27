import { parsePatchArguments, runPatchCli } from "./patch-cli.js";
import { visibleControls } from "./readonly-cli.js";

try {
  const options = parsePatchArguments(process.argv.slice(2));
  process.exitCode = await runPatchCli(options);
} catch (error) {
  const message = error instanceof Error ? error.message : "未知参数错误";
  process.stderr.write(`用法错误：${visibleControls(message)}\n`);
  process.stderr.write('示例：npm run patch -- --plan "修复输入校验" --file src/app.ts\n');
  process.exitCode = 2;
}
