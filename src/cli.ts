import { runReadonlyCli } from "./readonly-cli.js";

const question = process.argv.slice(2).join(" ");
const exitCode = await runReadonlyCli({ question });
process.exitCode = exitCode;
