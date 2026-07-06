import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "brain"))
from flux_brain.bus_ipc import IpcBus
bus = IpcBus()
def on_openocd(evt):
    d = evt.get("data", {})
    if d.get("cmd") == "cmd.flash" and "OK" in str(d.get("reply", "")):
        bus.publish({"source":"brain","kind":"execute","topic":"asset.committed",
                     "data":{"asset_id":"hpm6e00-bringup-001",
                             "components":["device-profile","driver","bench"]},
                     "trace_id":evt.get("trace_id","")})
bus.subscribe("openocd.event", on_openocd)
bus.publish({"source":"brain","kind":"log","topic":"brain.ready","data":{},"trace_id":""})
bus.run()
