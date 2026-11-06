import type { Request, Response } from 'express';
import type { ActivityLog, ActivityView } from '../reading/activity.ts';

export type Visibility = (a: ActivityView) => boolean;

export interface LiveStreamOptions {
  /** Comment line sent while idle so proxies and the browser keep the stream open. */
  readonly heartbeatMs?: number;
  /** Which activities this viewer may see; undefined shows all. Counters are always shared. */
  readonly visibleTo?: (res: Response) => Visibility | undefined;
  /**
   * Checked at every heartbeat: false ends the stream, so signing out or a deactivated account stops
   * the events. EventSource cannot read status codes; the panel notices through its next request.
   */
  readonly stillAllowed?: (req: Request) => Promise<boolean>;
}

/**
 * Server-Sent Events: first a `durum` event with the whole log, then one `etkinlik` event per change.
 * The browser's EventSource reconnects by itself and gets a fresh `durum` each time.
 */
export function liveStream(log: ActivityLog, opts: LiveStreamOptions = {}) {
  return (req: Request, res: Response): void => {
    const visible = opts.visibleTo?.(res);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    send('durum', log.snapshot(visible));
    const stop = log.subscribe((e) => {
      if (visible === undefined || visible(e.etkinlik)) send('etkinlik', e);
    });
    let closed = false;
    const end = (): void => {
      if (closed) return;
      closed = true;
      stop();
      clearInterval(heartbeat);
    };
    const heartbeat = setInterval(() => {
      if (opts.stillAllowed === undefined) {
        res.write(': canli\n\n');
        return;
      }
      opts.stillAllowed(req).then(
        (ok) => {
          if (closed) return;
          if (ok) {
            res.write(': canli\n\n');
          } else {
            end();
            res.end();
          }
        },
        // A database hiccup is not a reason to drop the viewer; the next beat checks again.
        () => {
          if (!closed) res.write(': canli\n\n');
        },
      );
    }, opts.heartbeatMs ?? 20_000);
    heartbeat.unref();
    req.on('close', end);
  };
}
