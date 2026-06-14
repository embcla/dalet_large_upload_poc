import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

jest.mock('./db', () => ({
  getNonTerminalUploads: jest.fn(),
}));

import { getNonTerminalUploads } from './db';
import { broadcast, handleProgressStream } from './progress';

function fakeRes() {
  const res = new EventEmitter() as unknown as Response & { write: jest.Mock; writeHead: jest.Mock };
  res.writeHead = jest.fn().mockReturnThis();
  res.write = jest.fn().mockReturnValue(true);
  return res;
}

function fakeReq() {
  return new EventEmitter() as unknown as Request;
}

/** Parses the SSE `data: {...}` line(s) out of every `res.write` call. */
function writtenEvents(res: ReturnType<typeof fakeRes>): unknown[] {
  return res.write.mock.calls
    .map(([chunk]: [string]) => chunk)
    .filter((chunk: string) => chunk.includes('data: '))
    .map((chunk: string) => JSON.parse(chunk.split('data: ')[1].trim()));
}

describe('progress (M5 SSE channel, §9)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (getNonTerminalUploads as jest.Mock).mockReturnValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('sends a 200 text/event-stream response with no-cache/keep-alive headers', () => {
    const req = fakeReq();
    const res = fakeRes();

    handleProgressStream(req, res);
    req.emit('close');

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }),
    );
  });

  it('sends a snapshot of non-terminal uploads on connect', () => {
    (getNonTerminalUploads as jest.Mock).mockReturnValue([
      { id: 'u1', status: 'uploading', bytes_received: 100, size: 1000 },
      { id: 'u2', status: 'paused', bytes_received: 50, size: 500 },
    ]);
    const req = fakeReq();
    const res = fakeRes();

    handleProgressStream(req, res);
    req.emit('close');

    expect(writtenEvents(res)).toEqual([
      { uploadId: 'u1', status: 'uploading', bytesReceived: 100, bytesTotal: 1000 },
      { uploadId: 'u2', status: 'paused', bytesReceived: 50, bytesTotal: 500 },
    ]);
  });

  it('broadcasts subsequent events to connected subscribers', () => {
    const req = fakeReq();
    const res = fakeRes();
    handleProgressStream(req, res);
    res.write.mockClear();

    broadcast({ uploadId: 'u1', status: 'uploading', bytesReceived: 200, bytesTotal: 1000 });

    expect(writtenEvents(res)).toEqual([
      { uploadId: 'u1', status: 'uploading', bytesReceived: 200, bytesTotal: 1000 },
    ]);

    req.emit('close');
  });

  it('uses an incrementing id: field across events', () => {
    const req = fakeReq();
    const res = fakeRes();
    handleProgressStream(req, res);

    broadcast({ uploadId: 'u1', status: 'uploading', bytesReceived: 1, bytesTotal: 10 });
    broadcast({ uploadId: 'u1', status: 'uploading', bytesReceived: 2, bytesTotal: 10 });

    const ids = res.write.mock.calls
      .map(([chunk]: [string]) => chunk)
      .filter((chunk: string) => chunk.startsWith('id: '))
      .map((chunk: string) => Number(chunk.match(/^id: (\d+)/)?.[1]));

    expect(ids[1]).toBe(ids[0] + 1);
    req.emit('close');
  });

  it('sends a keepalive comment on the configured interval', () => {
    const req = fakeReq();
    const res = fakeRes();
    handleProgressStream(req, res);
    res.write.mockClear();

    jest.advanceTimersByTime(20_000);

    expect(res.write).toHaveBeenCalledWith(': keepalive\n\n');
    req.emit('close');
  });

  it('sends a named ping event alongside the keepalive comment (M8 §12.1)', () => {
    const req = fakeReq();
    const res = fakeRes();
    handleProgressStream(req, res);
    res.write.mockClear();

    jest.advanceTimersByTime(20_000);

    const pingCall = res.write.mock.calls.find(([chunk]: [string]) => chunk.startsWith('event: ping\n'));
    expect(pingCall).toBeDefined();
    const data = JSON.parse((pingCall![0] as string).split('data: ')[1].trim());
    expect(typeof data.timestamp).toBe('number');
    req.emit('close');
  });

  it('stops broadcasting and clears the keepalive timer once the client disconnects', () => {
    const req = fakeReq();
    const res = fakeRes();
    handleProgressStream(req, res);

    req.emit('close');
    res.write.mockClear();

    broadcast({ uploadId: 'u1', status: 'success', bytesReceived: 10, bytesTotal: 10 });
    jest.advanceTimersByTime(60_000);

    expect(res.write).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no subscribers', () => {
    expect(() =>
      broadcast({ uploadId: 'u1', status: 'success', bytesReceived: 10, bytesTotal: 10 }),
    ).not.toThrow();
  });
});
