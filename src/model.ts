// Provider-agnostic chat-completion wrapper. Use OpenAI or Anthropic
// transparently — set OPENAI_API_KEY (preferred for the Waypoint demo) or
// ANTHROPIC_API_KEY. WAYPOINT_MODEL overrides the per-provider default.

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ToolSpec = {
  name: string;
  description: string;
  // JSON Schema (object) describing the tool's input.
  input_schema: Record<string, unknown>;
};

export type ToolHandler = (name: string, input: Record<string, unknown>) => Promise<string>;

export interface ModelClient {
  provider: "openai" | "anthropic";
  model: string;
  complete(system: string, messages: ChatMessage[]): Promise<string>;
  completeWithTools(
    system: string,
    messages: ChatMessage[],
    tools: ToolSpec[],
    toolHandler: ToolHandler,
    maxSteps?: number,
  ): Promise<string>;
}

const DEFAULTS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.4-mini",
};

const MAX_TOOL_STEPS_DEFAULT = 12;

export function getModelClient(): ModelClient {
  const override = process.env.WAYPOINT_MODEL;
  const anth = process.env.ANTHROPIC_API_KEY;
  const oai = process.env.OPENAI_API_KEY;

  if (oai) {
    const client = new OpenAI({ apiKey: oai });
    const model = override && !override.startsWith("claude") ? override : DEFAULTS.openai;
    return {
      provider: "openai",
      model,
      async complete(system, messages) {
        const res = await client.chat.completions.create({
          model,
          messages: [{ role: "system", content: system }, ...messages],
        });
        return res.choices[0]?.message?.content ?? "";
      },
      async completeWithTools(system, messages, tools, toolHandler, maxSteps = MAX_TOOL_STEPS_DEFAULT) {
        const oaiTools = tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));
        const convo: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: "system", content: system },
          ...messages.map((m) => ({ role: m.role, content: m.content }) as
            OpenAI.Chat.Completions.ChatCompletionMessageParam),
        ];

        for (let step = 0; step < maxSteps; step++) {
          const res = await client.chat.completions.create({
            model,
            messages: convo,
            tools: oaiTools,
          });
          const choice = res.choices[0];
          const msg = choice?.message;
          if (!msg) return "";
          const calls = msg.tool_calls ?? [];
          if (calls.length === 0) {
            return msg.content ?? "";
          }
          // Re-append assistant message with tool_calls verbatim.
          convo.push({
            role: "assistant",
            content: msg.content ?? "",
            tool_calls: calls,
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
          for (const call of calls) {
            if (call.type !== "function") continue;
            let parsed: Record<string, unknown> = {};
            try {
              parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              parsed = {};
            }
            let result: string;
            try {
              result = await toolHandler(call.function.name, parsed);
            } catch (e) {
              result = `ERROR: ${(e as Error).message}`;
            }
            convo.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
          }
        }
        // Hit step limit — force one final call without tools to extract text.
        const final = await client.chat.completions.create({
          model,
          messages: convo,
        });
        return final.choices[0]?.message?.content ?? "";
      },
    };
  }

  if (anth) {
    const client = new Anthropic({ apiKey: anth });
    const model = override?.startsWith("claude") ? override : DEFAULTS.anthropic;
    return {
      provider: "anthropic",
      model,
      async complete(system, messages) {
        const res = await client.messages.create({
          model,
          max_tokens: 8000,
          system,
          messages,
        });
        return res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      },
      async completeWithTools(system, messages, tools, toolHandler, maxSteps = MAX_TOOL_STEPS_DEFAULT) {
        const anthTools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        }));
        const convo: Anthropic.MessageParam[] = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        for (let step = 0; step < maxSteps; step++) {
          const res = await client.messages.create({
            model,
            max_tokens: 8000,
            system,
            tools: anthTools,
            messages: convo,
          });
          const toolUses = res.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );
          if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
            return res.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("\n");
          }
          // Append assistant turn (full content) and a user turn with tool_result blocks.
          convo.push({ role: "assistant", content: res.content });
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            let result: string;
            try {
              result = await toolHandler(tu.name, (tu.input ?? {}) as Record<string, unknown>);
            } catch (e) {
              result = `ERROR: ${(e as Error).message}`;
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: result,
            });
          }
          convo.push({ role: "user", content: toolResults });
        }
        // Hit step limit — final call without tools.
        const final = await client.messages.create({
          model,
          max_tokens: 8000,
          system,
          messages: convo,
        });
        return final.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      },
    };
  }

  throw new Error(
    "No model API key found. Set OPENAI_API_KEY (preferred) or ANTHROPIC_API_KEY.",
  );
}
