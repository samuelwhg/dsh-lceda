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
  reportRepo: string;
  allowGuiConcurrent: boolean;
}
declare const Config: Schema<Config>;
declare const name = "dsh-lceda";
declare const inject: string[];
interface ProjectIds {
  pcb?: string;
  sch?: string;
}
declare function projectIds(projectPath: string): ProjectIds;
/** Configured project, else the only .eprj3 in the workspace; '' when neither resolves. */
declare function projectOf(cfg: Config): string;
/** Configured id, else the first one of that kind inside the project. */
declare function needUuid(cfg: Config, kind: 'pcb' | 'sch'): string;
declare function apply(ctx: Context, config: Config): void;
export { Config, apply, inject, name, needUuid, projectIds, projectOf };