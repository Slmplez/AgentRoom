import { z } from 'zod';
const id = z.string().min(1).max(300);
export const engineSchema = z.object({ id, label: z.string(), installed: z.boolean() });
const assignment = z.object({ mode: z.enum(['workspace', 'custom', 'off']).default('workspace'), serverIds: z.array(id).default([]), skillIds: z.array(id).default([]) });
export const managementCommands = [
  z.object({ type: z.literal('createWorkspace'), key: id, title: z.string().trim().min(1).max(40), directory: z.string().min(1).max(2048) }),
  z.object({ type: z.literal('createRoom'), key: id, workspaceId: id, title: z.string().trim().min(1).max(40), memberIds: z.array(id).min(1).max(100) }),
  z.object({ type: z.literal('setRoomMembers'), key: id, roomId: id, memberIds: z.array(id).min(1).max(100) }),
  z.object({ type: z.literal('launchAgent'), key: id, workspaceId: id, engineId: id, tag: z.string().max(32).default(''), connectionId: z.string().max(300).default(''), model: z.string().max(200).optional(), capabilities: assignment.optional() }),
  z.object({ type: z.literal('stopAgent'), key: id, agentId: id }),
  z.object({ type: z.literal('removeAgent'), key: id, agentId: id }),
];
export const catalogSchema = z.object({ engines: z.array(engineSchema), version: z.string(), configurationError: z.string(), simulated: z.boolean().default(false) });
