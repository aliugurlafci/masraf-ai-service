// Reads a secret from stdin: TTY => raw mode without echo; pipe => the first line (trailing CR/LF removed).
import { OrcError } from '@orc/shared';

export const SECRET_INPUT_MAX_CHARS = 1024;

export interface SecretInputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

function tooLong(): OrcError {
  return new OrcError('validation_failed', `Secret input exceeds ${SECRET_INPUT_MAX_CHARS} characters`);
}

/** Non-TTY: resolves with the first line of the stream (EOF also terminates). */
export function readSecretLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.pause();
    };
    const finish = (value: string): void => {
      cleanup();
      resolve(value.replace(/\r$/, ''));
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        finish(buffer.slice(0, nl));
        return;
      }
      if (buffer.length > SECRET_INPUT_MAX_CHARS) {
        cleanup();
        reject(tooLong());
      }
    };
    const onEnd = (): void => finish(buffer);
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.resume();
  });
}

/** TTY: raw mode, no echo; Enter submits, Backspace edits, Ctrl-C / Ctrl-D abort. */
export function readSecretTty(stream: SecretInputStream, prompt: NodeJS.WritableStream, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const setRaw = (mode: boolean): void => {
      stream.setRawMode?.(mode);
    };
    const done = (err: Error | null): void => {
      stream.removeListener('data', onData);
      setRaw(false);
      stream.pause();
      prompt.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          done(null);
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          done(new OrcError('validation_failed', 'Secret input aborted'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        if (value.length > SECRET_INPUT_MAX_CHARS) {
          done(tooLong());
          return;
        }
      }
    };
    prompt.write(label);
    setRaw(true);
    stream.on('data', onData);
    stream.resume();
  });
}

/** Prompts twice on a TTY (must match); reads one line from a pipe. Empty input => validation error. */
export async function readSecret(
  stream: SecretInputStream,
  prompt: NodeJS.WritableStream,
  label: string,
): Promise<string> {
  let value: string;
  if (stream.isTTY === true) {
    value = await readSecretTty(stream, prompt, `${label}: `);
    const again = await readSecretTty(stream, prompt, `Repeat ${label.toLowerCase()}: `);
    if (again !== value) throw new OrcError('validation_failed', 'The two entries do not match');
  } else {
    value = await readSecretLine(stream);
  }
  if (value.length === 0) throw new OrcError('validation_failed', `${label} must not be empty`);
  return value;
}
