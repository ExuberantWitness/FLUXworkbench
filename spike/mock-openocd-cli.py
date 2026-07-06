import sys
sys.stderr.write("mock-openocd-cli ready (simulates connected OpenOCD)\n"); sys.stderr.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    head = line.split()[0]
    if head == "halt":           print("target state: halted")
    elif head == "flash":        print("flash write_image: OK")
    elif head == "mdw":          print("0x00000000: deadbeef cafebabe")
    elif head == "reset":        print("reset complete")
    else:                        print(f"?unknown:{head}")
    sys.stdout.flush()
