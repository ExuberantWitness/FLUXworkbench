import zenoh, time, struct, statistics, sys, threading
N = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
s = zenoh.open(zenoh.Config())
rtts = []; pending = {}; lock = threading.Lock()
def on_pong(sample):
    seq = struct.unpack("<Q", bytes(sample.payload)[:8])[0]
    with lock:
        if seq in pending:
            rtts.append(time.perf_counter() - pending.pop(seq))
s.declare_subscriber("flux/spike/pong", on_pong)
time.sleep(0.5)
t0 = time.perf_counter()
for i in range(N):
    with lock: pending[i] = time.perf_counter()
    s.put("flux/spike/ping", struct.pack("<Q", i))
deadline = time.perf_counter() + 10
while len(rtts) < N and time.perf_counter() < deadline:
    time.sleep(0.01)
elapsed = time.perf_counter() - t0
rtts_ms = sorted(r*1000 for r in rtts)
print(f"N={N} got={len(rtts)}/{N} elapsed={elapsed:.3f}s rate={len(rtts)/max(elapsed,1e-9):.0f} msg/s")
if rtts_ms:
    print(f"RTT ms: median={statistics.median(rtts_ms):.3f} p99={rtts_ms[min(int(len(rtts_ms)*0.99),len(rtts_ms)-1)]:.3f} max={rtts_ms[-1]:.3f}")
s.close()
