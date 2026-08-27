/**
 * 受限子进程执行工具。
 *
 * 插件只需要读取进程命令行来判断飞书 VC 是否正在运行。命令、参数、超时和输出上限
 * 都固定在这里，调用方不能传任意 shell，避免把同步插件变成命令执行入口。
 */

import { execFile } from "node:child_process";
const PS_PATH = "/bin/ps";
const COMMAND_TIMEOUT_MS = 3_000;
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

export async function listProcessCommands(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PS_PATH, ["-axo", "command"], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      encoding: "utf8",
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
