// A recording stand-in for the browser's AudioContext, enough for the real Web Audio backend to
// run in a plain unit test. It keeps every node the backend creates, what each was connected to,
// and the order of the scheduling calls, so tests can pin behaviour without any audio hardware.

export class FakeParam {
  value = 0;
  readonly calls: Array<{ method: string; args: number[] }> = [];
  private record(method: string, args: number[]) {
    this.calls.push({ method, args });
  }
  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.record("setValueAtTime", [v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.record("linearRampToValueAtTime", [v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.record("exponentialRampToValueAtTime", [v, t]);
  }
  setTargetAtTime(v: number, t: number, k: number) {
    this.record("setTargetAtTime", [v, t, k]);
  }
  cancelScheduledValues(t: number) {
    this.record("cancelScheduledValues", [t]);
  }
  /** The last ramp or target aimed at 0, if any. */
  aimedAtZero() {
    return this.calls.some(
      (c) =>
        (c.method === "linearRampToValueAtTime" || c.method === "setTargetAtTime") &&
        c.args[0] === 0,
    );
  }
}

class FakeNode {
  readonly outputs: FakeNode[] = [];
  disconnected = false;
  connect(to: FakeNode) {
    this.outputs.push(to);
    return to;
  }
  disconnect() {
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

export class FakeOscillator extends FakeNode {
  type = "sine";
  readonly frequency = new FakeParam();
  startedAt: number | undefined;
  stoppedAt: number | undefined;
  start(t: number) {
    this.startedAt = t;
  }
  stop(t: number) {
    this.stoppedAt = t;
  }
}

export class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  startedAt: number | undefined;
  readonly stops: number[] = [];
  start(t: number) {
    this.startedAt = t;
  }
  stop(t: number) {
    this.stops.push(t);
  }
}

export type DecodeMode = "auto" | "manual" | "reject";

export interface DecodeRequest {
  /** The byte length that reached decodeAudioData, to tell which asset it was. */
  bytes: number;
  buffer: { decoded: number };
  resolve(): void;
  reject(): void;
}

/** What `new AudioContext()` looks like to the backend. Created suspended, as browsers do. */
export class FakeAudioContext {
  state: "suspended" | "running" = "suspended";
  currentTime = 0;
  /** How far the clock moves once a resume() settles (a suspended context's clock is frozen). */
  resumeAdvance = 0;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];
  readonly sources: FakeSource[] = [];
  readonly decodes: DecodeRequest[] = [];
  decodeMode: DecodeMode = "auto";
  resumeCalls = 0;
  suspendCalls = 0;
  private decodeSeq = 0;

  createGain() {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  createOscillator() {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }
  createBufferSource() {
    const node = new FakeSource();
    this.sources.push(node);
    return node;
  }
  resume() {
    this.resumeCalls += 1;
    return new Promise<void>((done) => {
      setTimeout(() => {
        this.state = "running";
        this.currentTime += this.resumeAdvance;
        done();
      }, 0);
    });
  }
  suspend() {
    this.suspendCalls += 1;
    return new Promise<void>((done) => {
      this.state = "suspended";
      done();
    });
  }
  decodeAudioData(data: ArrayBuffer) {
    this.decodeSeq += 1;
    const buffer = { decoded: this.decodeSeq };
    return new Promise<{ decoded: number }>((resolve, reject) => {
      const request: DecodeRequest = {
        bytes: data.byteLength,
        buffer,
        resolve: () => resolve(buffer),
        reject: () => reject(new Error("unable to decode audio data")),
      };
      this.decodes.push(request);
      if (this.decodeMode === "auto") request.resolve();
      else if (this.decodeMode === "reject") request.reject();
    });
  }

  /** The master gain: the first gain the backend makes, wired to the destination. */
  get master(): FakeGain {
    const master = this.gains.find((g) => g.outputs.includes(this.destination));
    if (!master) throw new Error("no master gain wired to the destination");
    return master;
  }
  /** Gains feeding the master, in creation order: the cue bus(es) and any loop voices. */
  feedingMaster(): FakeGain[] {
    const master = this.master;
    return this.gains.filter((g) => g.outputs.includes(master));
  }
}

/** A context to hand to createWebAudioBackend, plus the typed handle the test inspects. */
export function fakeContextFactory() {
  const made: FakeAudioContext[] = [];
  const createContext = () => {
    const ctx = new FakeAudioContext();
    made.push(ctx);
    return ctx as unknown as AudioContext;
  };
  return {
    createContext,
    made,
    /** The one context the backend created. */
    get ctx(): FakeAudioContext {
      const ctx = made[0];
      if (!ctx) throw new Error("the backend has not created a context");
      return ctx;
    },
  };
}
