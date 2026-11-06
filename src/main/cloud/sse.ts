// Minimal Server-Sent Events parser (WHATWG "event stream" format) for the change feed
// (ADR-022). EventSource can't send `Authorization: Bearer`, so the client reads a fetch body
// stream and feeds the decoded text here.

export interface SseMessage {
  id?: string;
  event: string;
  data: string;
}

export class SseParser {
  private buf = '';
  private id: string | undefined;
  private event = '';
  private data: string[] = [];
  /** Last `id:` seen (survives across messages, like EventSource's lastEventId). */
  lastEventId: string | undefined;
  /** Last `retry:` value in ms. */
  retry: number | undefined;

  /** Feed a decoded chunk; returns the complete messages it finished. */
  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A lone trailing \r may be the first half of \r\n: wait for more input.
      if (m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') {
      if (!this.data.length && this.id === undefined) {
        this.event = '';
        return undefined;
      }
      if (this.id !== undefined) this.lastEventId = this.id;
      const msg: SseMessage = { ...(this.id !== undefined ? { id: this.id } : {}), event: this.event || 'message', data: this.data.join('\n') };
      this.id = undefined;
      this.event = '';
      this.data = [];
      // A message with only an id (no data) just moves lastEventId.
      return msg.data || msg.event !== 'message' ? msg : undefined;
    }
    if (line.startsWith(':')) return undefined; // comment / keep-alive
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    return undefined;
  }
}
