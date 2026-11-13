// The one adapter every model call goes through. Swapping vendors or models changes this file only,
// and the eval set (npm run eval) shows whether the swap holds up.
import Anthropic from '@anthropic-ai/sdk';
import { exec, type AgentTool, type ToolCtx } from '../tools/tools';

export const MODELS = {
  /** High-volume, simple extraction. */
  get fast() { return process.env.DOCKHAND_FAST_MODEL || 'claude-haiku-5-5'; },
  /** Planning and negotiation, where reasoning pays for itself. */
  get smart() { return process.env.DOCKHAND_SMART_MODEL || 'claude-sonnet-5-5'; }
};

export function modelEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.DOCKHAND_SCRIPTED !== '1';
}

let client: Anthropic | null = null;
const api = () => (client ??= new Anthropic({ timeout: 45_000, maxRetries: 1 }));

export interface FinalTool {
  name: string;
  description: string;
  input_schema: Anthropic.Messages.Tool.InputSchema;
}

/**
 * Tool-use loop: the model may call data tools, and finishes by calling the final tool, whose input
 * is the agent's structured answer. tool_choice stays "auto" because Sonnet 5.5 and newer reject
 * forced tool use while thinking is on; if the model answers in prose, it is asked to submit.
 * Thinking blocks go back to the API unmodified, as the docs require.
 */
export async function runAgent<T>(opts: {
  model: string; system: string; prompt: string; tools: AgentTool[]; final: FinalTool; ctx: ToolCtx; maxTurns?: number;
}): Promise<T> {
  const tools: Anthropic.Messages.Tool[] = [...opts.tools.map(t => t.def), { ...opts.final }];
  const system = opts.system + '\n\nWhen you have what you need, call ' + opts.final.name + ' exactly once. Do not reply in plain text.';
  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: opts.prompt }];
  const max = opts.maxTurns ?? 6;
  for (let turn = 0; turn < max; turn++) {
    const res = await api().messages.create({ model: opts.model, max_tokens: 8000, system, tools, tool_choice: { type: 'auto' }, messages });
    const uses = res.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
    const done = uses.find(u => u.name === opts.final.name);
    if (done) return done.input as T;
    messages.push({ role: 'assistant', content: res.content as unknown as Anthropic.Messages.ContentBlockParam[] });
    messages.push({
      role: 'user',
      content: uses.length
        ? uses.map(u => {
          const tool = opts.tools.find(t => t.def.name === u.name);
          const out = tool ? exec(tool, u.input, opts.ctx) : { error: 'Unknown tool ' + u.name };
          return { type: 'tool_result' as const, tool_use_id: u.id, content: JSON.stringify(out) };
        })
        : 'Call ' + opts.final.name + ' now with your answer.'
    });
  }
  throw new Error('Agent did not submit an answer in ' + max + ' turns');
}

export async function writeText(model: string, system: string, prompt: string): Promise<string> {
  const res = await api().messages.create({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: prompt }] });
  return res.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
}
