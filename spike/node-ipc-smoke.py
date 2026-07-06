import sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "brain"))
from flux_brain.bus_ipc import IpcBus
bus = IpcBus()
def on_ping(evt):
    bus.publish({"source":"brain","kind":"execute","topic":"pong","data":{"echo":evt.get("data")},"trace_id":evt.get("trace_id","")})
bus.subscribe("ping", on_ping)
bus.publish({"source":"brain","kind":"log","topic":"brain.ready","data":{},"trace_id":""})
bus.run()
