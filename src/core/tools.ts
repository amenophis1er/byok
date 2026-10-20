/**
 * The tools of a request told apart: the caller's function tools, which the
 * model calls and the caller runs, and the provider's server tools (web
 * search), which the provider runs itself.
 */

import type { AIChatRequest, AIServerTool, AIToolSpec } from '../types.js';

/** The caller's function tools. */
export function functionTools(req: Pick<AIChatRequest, 'tools'>): AIToolSpec[] {
  return (req.tools ?? []).filter((tool): tool is AIToolSpec => !('type' in tool));
}

/** The web search tool, when the request carries one. */
export function webSearchTool(req: Pick<AIChatRequest, 'tools'>): AIServerTool | undefined {
  return (req.tools ?? []).find((tool): tool is AIServerTool => 'type' in tool && tool.type === 'web_search');
}

/** A location as the providers take it: only the fields given. */
export function approximateLocation(tool: AIServerTool): Record<string, string> | undefined {
  const loc = tool.userLocation;
  if (!loc) return undefined;
  const out: Record<string, string> = {};
  for (const key of ['city', 'region', 'country', 'timezone'] as const) if (loc[key]) out[key] = loc[key]!;
  return Object.keys(out).length > 0 ? out : undefined;
}
