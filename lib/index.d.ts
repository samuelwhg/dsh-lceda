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
/** Configured id, else the first one of that kind inside the configured project. */
declare function needUuid(cfg: Config, kind: 'pcb' | 'sch'): string;
declare function apply(ctx: Context, config: Config): void;
export { Config, apply, inject, name, needUuid, projectIds };