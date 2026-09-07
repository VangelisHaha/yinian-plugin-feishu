/** AI 工具与普通同步复用鉴权、任务 API 和映射。 */
import {
  context,
  toolHandlers,
  taskItemSchema,
  textResult,
  withToolReceipt,
  type ToolDefinition,
} from "../sdk/index.mjs";
import { configOf, credentialsFrom } from "../feishu/pluginConfig.mjs";
import { requireCapability } from "../feishu/guard.mjs";
import { FeishuClient } from "../feishu/client.mjs";
import { toExternalItem } from "../feishu/mapping.mjs";
export const tools: ToolDefinition[] = [
  {
    name: "create_task",
    title: "创建飞书任务",
    description:
      "给当前授权用户创建任务，同时在一念保存并绑定这条任务。标题、说明、截止时间会写入飞书；其他本地字段保留在一念。",
    effect: "write",
    idempotent: true,
    binding: "task",
    inputSchema: {
      type: "object",
      properties: { item: taskItemSchema },
      required: ["item"],
      additionalProperties: false,
    },
    execute: async (request) => {
      const config = configOf(request);
      requireCapability(config, "tasks", context().dataDir);
      return withToolReceipt(context().dataDir, request, async () => {
        const task = await new FeishuClient(
          credentialsFrom(config),
          context().dataDir,
        ).createTask(
          request.arguments.item as {
            title: string;
            notes?: string;
            dueAt?: string;
          },
          request.operationId!,
        );
        return {
          ...textResult(
            `飞书任务已创建：${task.summary ?? ""}${task.url ? `\n${task.url}` : ""}`,
          ),
          binding: { resource: "task", item: toExternalItem(task, "todo")! },
        };
      });
    },
  },
];
export const handlers = toolHandlers(tools);
