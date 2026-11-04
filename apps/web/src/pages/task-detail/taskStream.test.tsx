import { describe, expect, it, vi } from 'vitest';
import { MockEventSource } from '../../test/eventSource';
import { IDS, claudeEvent, endEvent, logEvent } from '../../test/fixtures';
import { TaskStreamController, backoffDelayMs, resumeEventId, streamUrl } from './taskStream';
import type { TaskCheckOutcome } from './taskStream';

const STREAM = `/api/v1/tasks/${IDS.task}/stream`;

function setup(check: () => Promise<TaskCheckOutcome> = () => Promise.resolve('active')) {
  const sources: MockEventSource[] = [];
  const onEnd = vi.fn();
  const timers: { fn: () => void; ms: number }[] = [];
  const controller = new TaskStreamController({
    taskId: IDS.task,
    createSource: (url) => {
      const es = new MockEventSource(url);
      sources.push(es);
      return es;
    },
    checkTask: check,
    onEnd,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { controller, sources, onEnd, timers };
}

describe('TaskStreamController (contract §8.3, §8.4)', () => {
  it('builds the resume URL and caps the backoff at 30 s', () => {
    expect(streamUrl(IDS.task, null)).toBe(STREAM);
    expect(streamUrl(IDS.task, 'r-1730541600000-0')).toBe(`${STREAM}?lastEventId=r-1730541600000-0`);
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(resumeEventId('d-end')).toBeNull();
    expect(resumeEventId('d-42')).toBe('d-42');
  });

  it('reopens after a retry from the start when the last id was the synthetic d-end and still drops duplicates', () => {
    const { controller, sources, onEnd } = setup();
    controller.start();
    const first = sources[0]!;
    first.open();
    first.emit('log', logEvent(1, { content: 'old line\n' }), 'd-41');
    first.emit('end', endEvent({ status: 'failed' }), 'd-end');
    expect(first.closed).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().lastEventId).toBe('d-end');

    controller.reopen();
    expect(sources).toHaveLength(2);
    const second = sources[1]!;
    // resuming after d-end would always answer 204, so the stream restarts from the beginning
    expect(second.url).toBe(STREAM);
    second.open();
    second.emit('log', logEvent(1, { content: 'old line\n' }), 'r-1-0');
    second.emit('claude', claudeEvent(1, { attemptId: IDS.attempt2, text: 'new attempt' }), 'r-2-0');

    const items = controller.getSnapshot().items;
    expect(items.map((i) => i.type)).toEqual(['log', 'end', 'claude']);
    expect(controller.getSnapshot().connection).toBe('live');
    controller.stop();
    expect(second.closed).toBe(true);
  });

  it('resumes after an r- id unchanged and cancels the scheduled reconnect on stop', async () => {
    const { controller, sources, timers } = setup();
    controller.start();
    const first = sources[0]!;
    first.open();
    first.emit('claude', claudeEvent(1), 'r-100-0');
    first.fail(true);
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0]!.ms).toBe(1000);

    timers[0]!.fn();
    expect(sources[1]!.url).toBe(`${STREAM}?lastEventId=r-100-0`);

    sources[1]!.fail(true);
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    controller.stop();
    timers[1]!.fn();
    expect(sources).toHaveLength(2);
  });
});
