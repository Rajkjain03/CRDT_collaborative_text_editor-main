import {
  ConnectionManager,
  type WebSocketLike,
  type WebSocketConstructor,
} from "../src/client/ConnectionManager";

// ── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWebSocket implements WebSocketLike {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  sent: string[] = [];
  closed = false;
  closeCode?: number;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }
  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("not open");
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
    this.readyState = MockWebSocket.CLOSED;
  }
}

const MockWebSocketImpl = MockWebSocket as unknown as WebSocketConstructor;

function latestSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ── State machine ─────────────────────────────────────────────────────────────

describe("ConnectionManager — state transitions", () => {
  test("starts in disconnected state", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    expect(cm.getState()).toBe("disconnected");
  });

  test("connect() transitions to connecting", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    cm.connect();
    expect(cm.getState()).toBe("connecting");
  });

  test("socket open transitions to connected", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    cm.connect();
    latestSocket().simulateOpen();
    expect(cm.getState()).toBe("connected");
  });

  test("unexpected close transitions to reconnecting", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateClose();
    expect(cm.getState()).toBe("reconnecting");
  });

  test("disconnect() transitions to disconnected and does not reconnect", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    cm.connect();
    latestSocket().simulateOpen();
    cm.disconnect();
    expect(cm.getState()).toBe("disconnected");

    // Run any pending timers — nothing should happen
    jest.advanceTimersByTime(60000);
    expect(cm.getState()).toBe("disconnected");
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("connect() is idempotent when already connecting", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    cm.connect();
    cm.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

// ── Callbacks ─────────────────────────────────────────────────────────────────

describe("ConnectionManager — callbacks", () => {
  test("onOpen fires when socket opens", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    const onOpen = jest.fn();
    cm.onOpen = onOpen;
    cm.connect();
    latestSocket().simulateOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("onMessage fires with raw string data", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    const onMessage = jest.fn();
    cm.onMessage = onMessage;
    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateMessage("hello");
    expect(onMessage).toHaveBeenCalledWith("hello");
  });

  test("onMessage drops non-string (binary) messages", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    const onMessage = jest.fn();
    cm.onMessage = onMessage;
    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().onmessage?.({ data: new ArrayBuffer(8) });
    expect(onMessage).not.toHaveBeenCalled();
  });

  test("onClose fires on socket close", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    const onClose = jest.fn();
    cm.onClose = onClose;
    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("onStateChange fires on every state transition", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    const onStateChange = jest.fn();
    cm.onStateChange = onStateChange;

    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateClose();

    expect(onStateChange).toHaveBeenCalledWith("connecting");
    expect(onStateChange).toHaveBeenCalledWith("connected");
    expect(onStateChange).toHaveBeenCalledWith("reconnecting");
  });

  test("onStateChange does not fire for idempotent transitions", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    const onStateChange = jest.fn();
    cm.onStateChange = onStateChange;
    cm.connect();
    cm.connect(); // second call is no-op
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });
});

// ── send ──────────────────────────────────────────────────────────────────────

describe("ConnectionManager — send", () => {
  test("send returns true when socket is open", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    cm.connect();
    latestSocket().simulateOpen();
    expect(cm.send("hello")).toBe(true);
    expect(latestSocket().sent).toEqual(["hello"]);
  });

  test("send returns false when socket is not open", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    expect(cm.send("hello")).toBe(false);
  });

  test("send returns false when connecting but not yet open", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
    });
    cm.connect();
    expect(cm.send("hello")).toBe(false);
  });
});

// ── Reconnect backoff ─────────────────────────────────────────────────────────

describe("ConnectionManager — reconnect backoff", () => {
  test("reconnects after initial backoff on unexpected close", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
      initialBackoffMs: 500,
    });
    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateClose();

    expect(MockWebSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(500);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(cm.getState()).toBe("connecting");
  });

  test("backoff doubles after each failure", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
      initialBackoffMs: 100,
      backoffMultiplier: 2,
    });
    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateClose(); // first close — backoff 100

    expect(cm.getBackoffMs()).toBe(100);
    jest.advanceTimersByTime(100);
    // Second open attempt, then fail
    latestSocket().simulateClose(); // second close — backoff advances
    expect(cm.getBackoffMs()).toBe(200);

    jest.advanceTimersByTime(200);
    latestSocket().simulateClose();
    expect(cm.getBackoffMs()).toBe(400);
  });

  test("backoff caps at maxBackoffMs", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
      initialBackoffMs: 1000,
      maxBackoffMs: 3000,
      backoffMultiplier: 2,
    });
    cm.connect();
    // Fail many times
    for (let i = 0; i < 10; i++) {
      latestSocket().simulateOpen();
      latestSocket().simulateClose();
      jest.advanceTimersByTime(cm.getBackoffMs());
    }
    expect(cm.getBackoffMs()).toBeLessThanOrEqual(3000);
  });

  test("successful reconnect resets backoff to initial", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
      initialBackoffMs: 100,
    });
    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateClose();
    jest.advanceTimersByTime(100);
    latestSocket().simulateClose();
    expect(cm.getBackoffMs()).toBe(200);

    jest.advanceTimersByTime(200);
    latestSocket().simulateOpen(); // success resets backoff
    expect(cm.getBackoffMs()).toBe(100);
  });

  test("disconnect cancels pending reconnect", () => {
    const cm = new ConnectionManager("ws://test", {
      WebSocketImpl: MockWebSocketImpl,
      initialBackoffMs: 500,
    });
    cm.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateClose();
    expect(cm.getState()).toBe("reconnecting");

    cm.disconnect();
    jest.advanceTimersByTime(5000);
    expect(MockWebSocket.instances).toHaveLength(1); // no new socket created
    expect(cm.getState()).toBe("disconnected");
  });
});
