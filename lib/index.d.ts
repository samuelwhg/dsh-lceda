import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
interface Config {
  exePath: string;
  spawnCwd: string;
  projectPath: string;
  pcbUuid: string;
  schUuid: string;
  freeroutingJar: string;
  javaBin: string;
  sesDirWin: string;
  workDir: string;
  invokeTimeoutMs: number;
  routeTimeoutMs: number;
  allowGuiConcurrent: boolean;
}
declare const Config: Schema<Config>;
declare const name = "dsh-lceda";
declare const inject: string[];
declare function apply(ctx: Context, config: Config): void;
export { Config, apply, inject, name };