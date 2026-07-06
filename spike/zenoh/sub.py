import zenoh, time, sys
s = zenoh.open(zenoh.Config())
def on_ping(sample):
    s.put("flux/spike/pong", bytes(sample.payload))  # echo back
s.declare_subscriber("flux/spike/ping", on_ping)
print("sub ready", flush=True)
time.sleep(60)
s.close()
