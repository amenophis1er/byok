/**
 * What a turn reports while it streams, the same for every protocol. The
 * final `AIChatResult` is unchanged by observing: act on the result, since a
 * turn cut off by the limit or a filter may announce a call that the result
 * then withholds. Text deltas are the model's text as it arrives; the final
 * text may differ by trimming and by inline reasoning stripped from it.
 */

import type { AIChatResult } from '../types.js';

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsDelta: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; usage: NonNullable<AIChatResult['usage']> };

export type ChatEventSink = (event: ChatEvent) => void;
