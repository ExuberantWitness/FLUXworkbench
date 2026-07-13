# Renode PythonPeripheral: minimal STM32F1 RCC behavioral stub.
# Zephyr's clock driver polls CR ready bits and CFGR.SWS after switching —
# this model keeps every ready bit set and mirrors SW into SWS so any
# STM32F1 image boots. State: per-offset last written value.
if request.isInit:
    regs = {}
elif request.isWrite:
    regs[request.offset] = request.value
elif request.isRead:
    v = regs.get(request.offset, 0)
    if request.offset == 0x0:
        # CR: HSIRDY(1) | HSERDY(17) | PLLRDY(25) always ready
        request.value = v | 0x02020002
    elif request.offset == 0x4:
        # CFGR: SWS[3:2] mirrors SW[1:0]
        request.value = (v & ~0xC) | ((v & 0x3) << 2)
    else:
        request.value = v
