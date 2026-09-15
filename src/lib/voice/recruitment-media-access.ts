/** One media request, owned by one interview entry. Never bypass browser permissions. */
export type EntryMediaState = "idle" | "requesting" | "waiting" | "ready" | "denied" | "unavailable" | "failed";

export const ENTRY_MEDIA_MESSAGES: Record<EntryMediaState, string> = {
  idle: "",
  requesting: "正在连接摄像头和麦克风，请在浏览器的权限提示中选择允许。",
  waiting: "尚未获得摄像头和麦克风授权，面试还未开始。浏览器允许使用后会自动继续。",
  ready: "",
  denied: "浏览器尚未允许使用摄像头或麦克风，面试还未开始。权限恢复后会自动继续。",
  unavailable: "当前浏览器无法使用摄像头或麦克风，面试尚未开始，已有题目会保留。",
  failed: "暂时无法连接摄像头或麦克风，面试还未开始。设备恢复后会自动继续。",
};

export class RecruitmentMediaAccess {
  private state: EntryMediaState = "idle";
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private pending: Promise<MediaStream> | null = null;
  private resolve?: (stream: MediaStream) => void;
  private reject?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private lastRecovery = 0;
  private disposed = false;

  constructor(private readonly video: boolean) {}
  getSnapshot = (): EntryMediaState => this.state;
  cameraStream = (): MediaStream | undefined => this.stream && this.video
    ? new MediaStream(this.stream.getVideoTracks().map(track => track.clone())) : undefined;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private setState(state: EntryMediaState) { this.state = state; this.listeners.forEach(listener => listener()); }
  private live() {
    return this.stream?.getAudioTracks().some(t => t.readyState === "live")
      && (!this.video || this.stream.getVideoTracks().some(t => t.readyState === "live"));
  }

  request = (): Promise<MediaStream> => {
    if (this.disposed) return Promise.reject(new Error("Media entry disposed"));
    if (this.live()) return Promise.resolve(this.stream!);
    if (this.pending) return this.pending;
    if (this.state === "denied" || this.state === "unavailable") return Promise.reject(new Error(ENTRY_MEDIA_MESSAGES[this.state]));
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.pending = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    const result = this.pending;
    // Attach a handler immediately: the click initiates permission before the voice component mounts.
    void result.catch(() => {});
    this.attempt();
    return result;
  };

  private attempt() {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.setState("requesting");
    // This changes guidance only. It never cancels access or rejects a late permission result.
    this.timer = setTimeout(() => this.setState("waiting"), 8000);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("Media unavailable", "NotSupportedError");
      const permission = navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: this.video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
      });
      void permission.then(stream => {
        // Whichever outstanding native request succeeds first may satisfy the
        // logical entry. A late older grant must not be thrown away while its
        // replacement still waits for the browser.
        if (this.disposed || !this.pending) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        if (!this.live()) {
          stream.getTracks().forEach(t => t.stop());
          this.stream = null;
          if (generation === this.generation) this.fail(new DOMException("Required media track missing", "NotFoundError"));
          return;
        }
        clearTimeout(this.timer);
        const resolve = this.resolve;
        ++this.generation;
        this.pending = null; this.resolve = undefined; this.reject = undefined;
        this.setState("ready");
        resolve?.(stream);
      }, error => { if (!this.disposed && generation === this.generation) this.fail(error); });
    } catch (error) { this.fail(error); }
  }

  private fail(error: unknown) {
    clearTimeout(this.timer);
    const name = error instanceof Error ? error.name : "";
    const state = name === "NotAllowedError" || name === "SecurityError" ? "denied"
      : name === "NotSupportedError" || name === "NotFoundError" ? "unavailable" : "failed";
    const reject = this.reject;
    this.pending = null; this.resolve = undefined; this.reject = undefined;
    this.setState(state);
    reject?.(new Error(ENTRY_MEDIA_MESSAGES[state]));
  }

  /** Called on permission/device/browser recovery signals, never on a retry timer. */
  recover = async (): Promise<boolean> => {
    if (this.disposed || this.state === "ready" || this.state === "idle") return false;
    const names = this.video ? ["microphone", "camera"] : ["microphone"];
    const states = await Promise.all(names.map(async name => {
      try { return (await navigator.permissions.query({ name: name as PermissionName })).state; }
      catch { return "unknown"; }
    }));
    if (this.disposed || this.live() || states.includes("denied")) return false;
    if (this.pending) {
      // A confirmed grant can release a stale embedded-browser request. Keep the original
      // logical promise so its caller cannot create a second session or lose a late result.
      if (this.state !== "waiting" || !states.every(s => s === "granted") || Date.now() - this.lastRecovery < 8000) return false;
      this.lastRecovery = Date.now();
      this.attempt();
      return false;
    }
    this.setState("idle");
    return true;
  };

  dispose = () => {
    this.disposed = true;
    ++this.generation;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.reject?.(new Error("Media entry disposed"));
    this.pending = null; this.resolve = undefined; this.reject = undefined;
  };
}
