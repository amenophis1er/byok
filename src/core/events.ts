/**
 * What a turn reports while it streams, the same for every protocol.
 *
 * Lifecycle: a call is announced once (`tool_call_start`, with the id and name
 * the result will carry), its arguments follow as JSON text in pieces (whole,
 * in one piece, from the Gemini API, which sends them as an object), and it
 * ends once (`tool_call_end`) — at the latest when the turn does. `usage` comes
 * last, once the turn is done, and is a copy.
 *
 * The events are provisional; the result is the authority. A turn cut off by
 * the limit, a filter or a failure may have announced calls that the result
 * then withholds, and a stream that fails mid-turn leaves what came before
 * reported and the failure as the result. Text deltas are the model's text as
 * it arrives; the final text may differ by trimming and by inline reasoning
 * stripped from it. Observing never changes the result.
 */

import type { AIChatResult } from '../types.js';

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsDelta: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; usage: NonNullable<AIChatResult['usage']> };

export type ChatEventSink = (event: ChatEvent) => void;
